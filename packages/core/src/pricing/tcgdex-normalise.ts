import { parseCents } from '../catalog/tcgdex/money';
import type { CardIdentity, MarketQuote, PricingCurrency, PricingLanguage, QuoteKind, QuoteType } from './types';

export const TCGDEX_PROVIDER = 'tcgdex';

export interface NormaliseOptions {
  language: PricingLanguage;
  cardId: string;
  /** When we fetched the card (ISO-8601 UTC). */
  observedAt: string;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** TCGplayer price-key -> neutral variant/variantDetail. Naming follows the catalog builder (prices.ts). */
const TCGPLAYER_KEYS: Record<string, { variant: string; variantDetail: string }> = {
  normal: { variant: 'normal', variantDetail: '' },
  holofoil: { variant: 'holo', variantDetail: '' },
  'reverse-holofoil': { variant: 'reverse_holo', variantDetail: '' },
  reverse: { variant: 'reverse_holo', variantDetail: '' },
  unlimited: { variant: 'normal', variantDetail: 'unlimited' },
  'unlimited-holofoil': { variant: 'holo', variantDetail: 'unlimited' },
  '1st-edition': { variant: 'first_edition', variantDetail: 'normal' },
  '1st-edition-normal': { variant: 'first_edition', variantDetail: 'normal' },
  '1st-edition-holofoil': { variant: 'first_edition', variantDetail: 'holo' },
  '1st-edition-shadowless': { variant: 'first_edition', variantDetail: 'shadowless:normal' },
  '1st-edition-shadowless-holofoil': { variant: 'first_edition', variantDetail: 'shadowless:holo' },
  shadowless: { variant: 'shadowless', variantDetail: 'normal' },
  'shadowless-holofoil': { variant: 'shadowless', variantDetail: 'holo' }
};

/**
 * TCGplayer fields. All are `listing-estimate`: TCGdex relays TCGplayer's own low/mid/high/market/direct-low
 * figures, which we cannot audit as individual sales (TCGplayer describes marketPrice as based on recent sales,
 * but it is a provider-computed number, so we do not label it a verified sale or a sale average).
 */
const TCGPLAYER_FIELDS: ReadonlyArray<readonly [string, QuoteType, QuoteKind]> = [
  ['marketPrice', 'market', 'listing-estimate'],
  ['midPrice', 'mid', 'listing-estimate'],
  ['lowPrice', 'low', 'listing-estimate'],
  ['highPrice', 'high', 'listing-estimate'],
  ['directLowPrice', 'directLow', 'listing-estimate']
];

/**
 * Cardmarket fields (suffix '' = non-foil, '-holo' = foil). avg/avg1/avg7/avg30 are averages of SALES per
 * Cardmarket (TCGdex: "Average selling price", "last 24 hours/7 days/30 days") => provider-sale-average.
 * `low` is the cheapest current listing and `trend` is Cardmarket's own chart "price trend" => listing-estimate
 * (conservative: trend is a blend we cannot audit).
 */
const CARDMARKET_FIELDS: ReadonlyArray<readonly [string, QuoteType, QuoteKind]> = [
  ['avg', 'avg', 'provider-sale-average'],
  ['avg1', 'avg1', 'provider-sale-average'],
  ['avg7', 'avg7', 'provider-sale-average'],
  ['avg30', 'avg30', 'provider-sale-average'],
  ['low', 'low', 'listing-estimate'],
  ['trend', 'trend', 'listing-estimate']
];

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function currencyOf(block: Json, expected: PricingCurrency): PricingCurrency | null {
  if (block.unit === undefined || block.unit === null) return expected;
  return block.unit === expected ? expected : null; // a block in an unexpected unit is dropped, never relabelled
}

/**
 * Pure: TCGdex card `pricing` object -> MarketQuote[]. Null/absent/invalid/negative values produce no quote.
 * A value of exactly 0 is also dropped: Cardmarket reports 0 for "no data" (e.g. ja SV1S-001 `trend-holo: 0`
 * alongside `avg-holo: null`), and a 0-cent market price is never meaningful.
 * Output order is deterministic: tcgplayer (key order of the payload, then field order), then cardmarket.
 */
export function normaliseTcgdexPricing(pricing: unknown, options: NormaliseOptions): MarketQuote[] {
  if (!isRecord(pricing)) return [];
  const out: MarketQuote[] = [];
  const push = (identity: CardIdentity, quoteType: QuoteType, kind: QuoteKind, currency: PricingCurrency, raw: unknown, providerUpdatedAt: string | null) => {
    const { cents } = parseCents(raw);
    if (cents === null || cents <= 0) return;
    out.push({ provider: TCGDEX_PROVIDER, cardIdentity: identity, quoteType, kind, currency, cents, observedAt: options.observedAt, providerUpdatedAt });
  };

  const tcg = pricing.tcgplayer;
  if (isRecord(tcg)) {
    const currency = currencyOf(tcg, 'USD');
    const updated = isoOrNull(tcg.updated);
    if (currency) {
      for (const [key, entry] of Object.entries(tcg)) {
        if (!isRecord(entry)) continue; // skips updated/unit and anything non-object
        const mapped = TCGPLAYER_KEYS[key] ?? { variant: 'other', variantDetail: key };
        const identity: CardIdentity = { language: options.language, cardId: options.cardId, ...mapped };
        for (const [field, quoteType, kind] of TCGPLAYER_FIELDS) push(identity, quoteType, kind, currency, entry[field], updated);
      }
    }
  }

  const cm = pricing.cardmarket;
  if (isRecord(cm)) {
    const currency = currencyOf(cm, 'EUR');
    const updated = isoOrNull(cm.updated);
    if (currency) {
      // Cardmarket only separates non-foil from foil; it cannot say whether foil is holo or reverse holo, so the
      // variant names the bucket rather than guessing a print.
      for (const [suffix, variant] of [['', 'cardmarket-nonfoil'], ['-holo', 'cardmarket-foil']] as const) {
        const identity: CardIdentity = { language: options.language, cardId: options.cardId, variant, variantDetail: '' };
        for (const [field, quoteType, kind] of CARDMARKET_FIELDS) push(identity, quoteType, kind, currency, cm[`${field}${suffix}`], updated);
      }
    }
  }
  return out;
}
