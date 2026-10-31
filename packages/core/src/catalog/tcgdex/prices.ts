import { sha256Hex } from '../sha256';
import { parseCents } from './money';
import { toUtcIso } from './text';
import type { MappedPrint } from './variants';
import type {
  CatalogLanguage, CatalogLatestPriceRow, CatalogPriceSource, CatalogVariant, MapWarning, RawJson, RawPricing
} from './types';

type Quote = Pick<CatalogLatestPriceRow, 'lowCents' | 'midCents' | 'highCents' | 'marketCents' | 'trendCents'>;

interface Candidate {
  source: CatalogPriceSource;
  variant: CatalogVariant;
  variantDetail: string;
  providerVariantKey: string;
  currency: 'USD' | 'EUR';
  quote: Quote;
  sourceUpdatedAt: string | null;
}

function isRecord(value: unknown): value is RawJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * TCGplayer price key candidates for a matched print (DATA-MODEL table). The key is chosen BY NAME on the
 * matched row - never "first key wins" and never a fallback to a sibling key.
 */
export function tcgplayerKeyCandidates(print: MappedPrint): string[] {
  const { variant, variantDetail: d } = print;
  switch (variant) {
    // 'unlimited' rows: the table names `unlimited`/`unlimited-holofoil`, but live base1-4 evidence
    // (research/variants-and-pricing.md) keys the unlimited holo row as plain `holofoil`; both are
    // names ON THE MATCHED ROW, never a sibling row's key.
    case 'normal': return d === '' ? ['normal'] : d === 'unlimited' ? ['unlimited', 'normal'] : [];
    case 'holo': return d === '' ? ['holofoil'] : d === 'unlimited' ? ['unlimited-holofoil', 'holofoil'] : d === 'gold' ? ['holofoil'] : [];
    case 'reverse_holo': return d === '' ? ['reverse-holofoil'] : d === 'pokeball' || d === 'masterball' ? ['holofoil'] : [];
    case 'first_edition':
      if (d === 'normal') return ['1st-edition', '1st-edition-normal'];
      if (d === 'holo') return ['1st-edition-holofoil'];
      if (d === 'shadowless:holo') return ['1st-edition-shadowless-holofoil'];
      if (d === 'shadowless:normal') return ['1st-edition-shadowless'];
      return [];
    case 'shadowless':
      if (d === 'holo') return ['shadowless-holofoil'];
      if (d === 'normal') return ['shadowless'];
      return [];
    default: return []; // promo_stamped / other: only an explicitly identified key, otherwise null
  }
}

function mapTcgplayer(print: MappedPrint, block: RawJson, warnings: MapWarning[], cardId: string): Candidate | null {
  if (typeof block.unit === 'string' && block.unit !== 'USD') {
    warnings.push({ code: 'PRICE_UNIT', cardId, message: `tcgplayer unit ${block.unit} is not USD; skipped` });
    return null;
  }
  const keys = tcgplayerKeyCandidates(print);
  const priceKey = keys.find((key) => isRecord(block[key]));
  if (!priceKey) return null;
  const entry = block[priceKey] as RawJson;
  const values = {
    low: parseCents(entry.lowPrice), mid: parseCents(entry.midPrice), high: parseCents(entry.highPrice), market: parseCents(entry.marketPrice)
  };
  for (const [name, result] of Object.entries(values)) {
    if (result.warning) warnings.push({ code: 'PRICE_VALUE', cardId, message: `tcgplayer ${priceKey}.${name}: ${result.warning} value ignored` });
  }
  const quote: Quote = { lowCents: values.low.cents, midCents: values.mid.cents, highCents: values.high.cents, marketCents: values.market.cents, trendCents: null };
  if (Object.values(quote).every((v) => v === null)) return null;
  const productId = entry.productId ?? print.row.thirdParty?.tcgplayer ?? '';
  return {
    source: 'tcgplayer', variant: print.variant, variantDetail: print.variantDetail, currency: 'USD', quote,
    providerVariantKey: `${productId}:${priceKey}:${print.variantDetail}`,
    sourceUpdatedAt: toUtcIso(block.updated)
  };
}

function cardmarketNumber(block: RawJson, field: string): number | null | undefined {
  const raw = block[field];
  return raw === undefined ? undefined : parseCentsPlaceholder(raw);
}
function parseCentsPlaceholder(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Foil rule: nonfoil -> avg; foil -> avg-holo, or plain avg only when the distinct print has no avg-holo. */
function mapCardmarket(print: MappedPrint, block: RawJson, warnings: MapWarning[], cardId: string, ambiguousFoil: boolean): Candidate | null {
  if (typeof block.unit === 'string' && block.unit !== 'EUR') {
    warnings.push({ code: 'PRICE_UNIT', cardId, message: `cardmarket unit ${block.unit} is not EUR; skipped` });
    return null;
  }
  const isFoil = print.attrs.type === 'holo' || print.attrs.type === 'reverse';
  const avg = cardmarketNumber(block, 'avg');
  const avgHolo = cardmarketNumber(block, 'avg-holo');
  let suffix: '' | '-holo';
  if (!isFoil) suffix = '';
  else if (avgHolo !== null && avgHolo !== undefined) suffix = '-holo';
  else suffix = '';
  if (isFoil && ambiguousFoil) return null; // handled by the cardmarket_holo_unspecified row
  const midRaw = suffix === '' ? avg : avgHolo;
  if (midRaw === null || midRaw === undefined) return null; // no EUR price on that print
  const values = {
    low: parseCents(block[`low${suffix}`]), mid: parseCents(block[`avg${suffix}`]), trend: parseCents(block[`trend${suffix}`])
  };
  for (const [name, result] of Object.entries(values)) {
    if (result.warning) warnings.push({ code: 'PRICE_VALUE', cardId, message: `cardmarket ${name}${suffix}: ${result.warning} value ignored` });
  }
  const quote: Quote = { lowCents: values.low.cents, midCents: values.mid.cents, highCents: null, marketCents: null, trendCents: values.trend.cents };
  if (Object.values(quote).every((v) => v === null)) return null;
  const productId = block.idProduct ?? print.row.thirdParty?.cardmarket ?? '';
  return {
    source: 'cardmarket', variant: print.variant, variantDetail: print.variantDetail, currency: 'EUR', quote,
    providerVariantKey: `${productId}:avg${suffix}:${print.variantDetail}`,
    sourceUpdatedAt: toUtcIso(block.updated)
  };
}

function cardmarketProduct(print: MappedPrint, block: RawJson | null): string | null {
  const id = block?.idProduct ?? print.row.thirdParty?.cardmarket;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Latest-price rows for one card. Price blocks are read from the MATCHED detailed row. Root `pricing` is
 * used only when the card has exactly one detailed row (unambiguous). Rows without any number are not
 * stored; a missing price is never fabricated or filled from a sibling.
 */
export function mapLatestPrices(
  language: CatalogLanguage,
  cardId: string,
  prints: readonly MappedPrint[],
  rootPricing: RawPricing | null | undefined,
  capturedAt: string,
  warnings: MapWarning[]
): CatalogLatestPriceRow[] {
  const pricingFor = (print: MappedPrint): RawPricing | null => {
    if (isRecord(print.row.pricing)) return print.row.pricing as RawPricing;
    if (prints.length === 1 && isRecord(rootPricing)) return rootPricing;
    return null;
  };

  // Ambiguous shared foil quote: a plain holo AND a plain reverse_holo print on the same cardmarket product.
  const foilByProduct = new Map<string, MappedPrint[]>();
  for (const print of prints) {
    if (print.variantDetail !== '' || (print.variant !== 'holo' && print.variant !== 'reverse_holo')) continue;
    const block = pricingFor(print)?.cardmarket;
    const product = cardmarketProduct(print, isRecord(block) ? block : null);
    if (product) foilByProduct.set(product, [...(foilByProduct.get(product) ?? []), print]);
  }
  const ambiguousProducts = new Set([...foilByProduct].filter(([, list]) => new Set(list.map((p) => p.variant)).size > 1).map(([product]) => product));

  const candidates: Candidate[] = [];
  for (const print of prints) {
    const pricing = pricingFor(print);
    if (!pricing) continue;
    if (isRecord(pricing.tcgplayer)) {
      const candidate = mapTcgplayer(print, pricing.tcgplayer, warnings, cardId);
      if (candidate) candidates.push(candidate);
    }
    if (isRecord(pricing.cardmarket)) {
      const product = cardmarketProduct(print, pricing.cardmarket);
      const candidate = mapCardmarket(print, pricing.cardmarket, warnings, cardId, product !== null && ambiguousProducts.has(product));
      if (candidate) candidates.push(candidate);
    }
  }
  for (const product of ambiguousProducts) {
    const print = foilByProduct.get(product)![0]!;
    const block = pricingFor(print)!.cardmarket as RawJson;
    if (block['avg-holo'] === null || block['avg-holo'] === undefined) continue;
    const values = { low: parseCents(block['low-holo']), mid: parseCents(block['avg-holo']), trend: parseCents(block['trend-holo']) };
    candidates.push({
      source: 'cardmarket', variant: 'other', variantDetail: 'cardmarket_holo_unspecified', currency: 'EUR',
      quote: { lowCents: values.low.cents, midCents: values.mid.cents, highCents: null, marketCents: null, trendCents: values.trend.cents },
      providerVariantKey: `${product}:avg-holo:cardmarket_holo_unspecified`,
      sourceUpdatedAt: toUtcIso(block.updated)
    });
  }

  // Dedupe by the UNIQUE tuple; keep the newer provider timestamp.
  const byTuple = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const tuple = JSON.stringify([candidate.source, candidate.variant, candidate.variantDetail, candidate.providerVariantKey, candidate.currency]);
    const existing = byTuple.get(tuple);
    if (!existing || (candidate.sourceUpdatedAt ?? '') > (existing.sourceUpdatedAt ?? '')) byTuple.set(tuple, candidate);
  }
  const rows = [...byTuple.values()].map((c): CatalogLatestPriceRow => {
    const observationKey = sha256Hex(JSON.stringify([
      language, cardId, c.source, c.variant, c.variantDetail, c.providerVariantKey, c.currency, c.sourceUpdatedAt,
      c.quote.lowCents, c.quote.midCents, c.quote.highCents, c.quote.marketCents, c.quote.trendCents
    ]));
    return {
      id: observationKey, language, catalogCardId: cardId, source: c.source, variant: c.variant, variantDetail: c.variantDetail,
      providerVariantKey: c.providerVariantKey, currency: c.currency, ...c.quote, sourceUpdatedAt: c.sourceUpdatedAt, capturedAt, observationKey
    };
  });
  return rows.sort((a, b) =>
    a.source.localeCompare(b.source) || a.variant.localeCompare(b.variant) || a.variantDetail.localeCompare(b.variantDetail)
    || a.providerVariantKey.localeCompare(b.providerVariantKey));
}
