import type { Currency, PriceDto, ValuationDto } from '@flashydex/schemas';


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

/** Valuations of one copy, USD then EUR. Manual wins and replaces every automatic valuation; graded without override has none. */
export function valuationsFor(copy: ValuationInput, quotes: readonly Quote[]): ValuationDto[] {
  if (copy.manual) {
    return [{ currency: copy.manual.currency, cents: copy.manual.cents, source: 'manual', priceSnapshotId: null, capturedAt: copy.updatedAt }];
  }
  if (copy.graded) return [];
  const out: ValuationDto[] = [];
  for (const currency of ['USD', 'EUR'] as const) {
    const value = automaticValue(quotes, copy.variant, copy.variantDetail, currency);
    if (value) {
      out.push({ currency, cents: value.cents, source: SOURCE_FOR[currency], priceSnapshotId: value.quote.id, capturedAt: value.quote.capturedAt });
    }
  }
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
