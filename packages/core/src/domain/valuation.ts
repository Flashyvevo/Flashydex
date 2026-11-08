import type { Currency, PriceDto, ValuationDto } from '@flashydex/schemas';
import { tryConvertCents, type FxContext } from './fx';


/** Pure valuation math (DATA-MODEL "Definitions for every screen and aggregate"). No I/O, no clock. */


export type Quote = {
  id: string;
  language: 'en' | 'ja';
  catalogCardId: string;
  source: 'tcgplayer' | 'cardmarket';
  variant: string;
  variantDetail: string;
  providerVariantKey: string;
  currency: Currency;
  lowCents: number | null;
  midCents: number | null;
  highCents: number | null;
  marketCents: number | null;
  trendCents: number | null;
  sourceUpdatedAt: string | null;
  capturedAt: string;
};

export type ValuationInput = {
  variant: string;
  variantDetail: string;
  graded: boolean;
  manual: { cents: number; currency: Currency } | null;
  /** Instant used as `capturedAt` for a manual valuation (the copy's updatedAt). */
  updatedAt: string;
};

export const MAX_CENTS = 2147483647;

/** sourceUpdatedAt DESC NULLS LAST, then capturedAt DESC, then id DESC. Negative = a is newer. */
export function compareNewest(a: Pick<Quote, 'sourceUpdatedAt' | 'capturedAt' | 'id'>, b: Pick<Quote, 'sourceUpdatedAt' | 'capturedAt' | 'id'>): number {
  if (a.sourceUpdatedAt !== b.sourceUpdatedAt) {
    if (a.sourceUpdatedAt === null) return 1;
    if (b.sourceUpdatedAt === null) return -1;
    return a.sourceUpdatedAt < b.sourceUpdatedAt ? 1 : -1;
  }
  if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

const SOURCE_FOR: Record<Currency, 'tcgplayer' | 'cardmarket'> = { USD: 'tcgplayer', EUR: 'cardmarket' };

/** Newest quote for an exact (source, variant, detail) print. No fallback to another variant, currency or older row. */
export function latestQuote(quotes: readonly Quote[], source: 'tcgplayer' | 'cardmarket', variant: string, variantDetail: string): Quote | null {
  let best: Quote | null = null;
  for (const quote of quotes) {
    if (quote.source !== source || quote.variant !== variant || quote.variantDetail !== variantDetail) continue;
    if (best === null || compareNewest(quote, best) < 0) best = quote;
  }
  return best;
}

/** Effective automatic value for one currency: USD = market then mid; EUR = mid (avg). Never low/trend/directLow. */
export function automaticValue(quotes: readonly Quote[], variant: string, variantDetail: string, currency: Currency): { cents: number; quote: Quote } | null {
  const quote = latestQuote(quotes, SOURCE_FOR[currency], variant, variantDetail);
  if (!quote) return null;
  const cents = currency === 'USD' ? (quote.marketCents ?? quote.midCents) : quote.midCents;
  return cents === null ? null : { cents, quote };
}

export type UsdResolution =
  | { kind: 'native'; cents: number; quote: Quote }
  | { kind: 'converted'; cents: number; quote: Quote; fx: FxContext }
  /** A usable Cardmarket (EUR) quote exists for the exact print but there is no usable FX record: USD is unavailable, never guessed. */
  | { kind: 'fx_unavailable'; quote: Quote }
  | { kind: 'none' };

/**
 * USD value of an exact (variant, detail) print: (a) TCGplayer market → mid; (b) else Cardmarket mid (EUR) × FX.
 * Never mixes variants; never adds currencies; the original EUR quote is untouched.
 */
export function resolveUsd(quotes: readonly Quote[], variant: string, variantDetail: string, fx: FxContext | null | undefined): UsdResolution {
  const native = automaticValue(quotes, variant, variantDetail, 'USD');
  if (native) return { kind: 'native', cents: native.cents, quote: native.quote };
  const eur = automaticValue(quotes, variant, variantDetail, 'EUR');
  if (!eur) return { kind: 'none' };
  if (!fx) return { kind: 'fx_unavailable', quote: eur.quote };
  const cents = tryConvertCents(eur.cents, fx.record.rate);
  if (cents === null) return { kind: 'fx_unavailable', quote: eur.quote };
  return { kind: 'converted', cents, quote: eur.quote, fx };
}

/** Valuations of one copy, USD then EUR. Manual wins and replaces every automatic valuation; graded without override has none. */
export function valuationsFor(copy: ValuationInput, quotes: readonly Quote[], fx?: FxContext | null): ValuationDto[] {
  if (copy.manual) {
    return [{ currency: copy.manual.currency, cents: copy.manual.cents, source: 'manual', priceSnapshotId: null, capturedAt: copy.updatedAt }];
  }
  if (copy.graded) return [];
  const out: ValuationDto[] = [];
  const usd = resolveUsd(quotes, copy.variant, copy.variantDetail, fx);
  if (usd.kind === 'native') {
    out.push({
      currency: 'USD', cents: usd.cents, source: 'tcgplayer', priceSnapshotId: usd.quote.id, capturedAt: usd.quote.capturedAt,
      quoteType: usd.quote.marketCents !== null ? 'market' : 'mid'
    });
  } else if (usd.kind === 'converted') {
    out.push({
      currency: 'USD', cents: usd.cents, source: 'cardmarket', priceSnapshotId: usd.quote.id, capturedAt: usd.quote.capturedAt,
      converted: true, originalCents: usd.quote.midCents as number, originalCurrency: 'EUR', fxRate: usd.fx.record.rate,
      fxRateDate: usd.fx.record.rateDate, fxProvider: usd.fx.record.provider, quoteType: 'avg', stale: usd.fx.stale
    });
  }
  const eur = automaticValue(quotes, copy.variant, copy.variantDetail, 'EUR');
  if (eur) out.push({ currency: 'EUR', cents: eur.cents, source: 'cardmarket', priceSnapshotId: eur.quote.id, capturedAt: eur.quote.capturedAt, quoteType: 'avg' });
  return out;
}

export const valueIn = (valuations: readonly ValuationDto[], currency: Currency): number | null =>
  valuations.find((v) => v.currency === currency)?.cents ?? null;

/** Latest quote per (source, variant, detail, currency, providerVariantKey). */
export function latestPerKey(quotes: readonly Quote[]): PriceDto[] {
  const best = new Map<string, Quote>();
  for (const quote of quotes) {
    const key = [quote.source, quote.variant, quote.variantDetail, quote.currency, quote.providerVariantKey].join('\u0000');
    const current = best.get(key);
    if (!current || compareNewest(quote, current) < 0) best.set(key, quote);
  }
  return [...best.values()]
    .sort((a, b) => a.source.localeCompare(b.source) || a.variant.localeCompare(b.variant) || a.variantDetail.localeCompare(b.variantDetail) || a.providerVariantKey.localeCompare(b.providerVariantKey))
    .map((q) => ({
      id: q.id, catalogCardId: q.catalogCardId, language: q.language, source: q.source, variant: q.variant as PriceDto['variant'],
      variantDetail: q.variantDetail, providerVariantKey: q.providerVariantKey, currency: q.currency, lowCents: q.lowCents, midCents: q.midCents,
      highCents: q.highCents, marketCents: q.marketCents, trendCents: q.trendCents, sourceUpdatedAt: q.sourceUpdatedAt, capturedAt: q.capturedAt
    }));
}

export function safeAdd(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('Sum exceeds the safe integer range');
  return sum;
}

export function safeMul(a: number, b: number): number {
  const product = a * b;
  if (!Number.isSafeInteger(product)) throw new RangeError('Product exceeds the safe integer range');
  return product;
}
