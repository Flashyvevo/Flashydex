import { describe, expect, it } from 'vitest';
import type { PriceDto } from '../data';
import { hasCurrencyPrice, priceGap } from './price-gap';

const row = (over: Partial<PriceDto>): PriceDto => ({
  id: 'p', catalogCardId: 'c', language: 'en', source: 'cardmarket', variant: 'normal', variantDetail: '', providerVariantKey: '',
  currency: 'EUR', lowCents: null, midCents: null, highCents: null, marketCents: null, trendCents: null,
  sourceUpdatedAt: '2026-10-12T00:00:00Z', capturedAt: '2026-10-13T00:00:00Z', ...over
}) as PriceDto;

describe('priceGap', () => {
  it('USD tab with only EUR: reports the euro trend with source and date, no conversion', () => {
    const gap = priceGap([row({ trendCents: 123 })], 'USD');
    expect(gap).toEqual({ missing: 'USD', other: 'EUR', cents: 123, source: 'Cardmarket', asOf: '2026-10-12T00:00:00Z' });
  });
  it('EUR tab with only USD: reports the dollar market price', () => {
    const gap = priceGap([row({ currency: 'USD', source: 'tcgplayer', marketCents: 450 })], 'EUR');
    expect(gap).toMatchObject({ missing: 'EUR', other: 'USD', cents: 450, source: 'TCGplayer' });
  });
  it('no gap when the tab has its own price, or when neither currency has one', () => {
    expect(priceGap([row({ trendCents: 100 }), row({ id: 'q', currency: 'USD', source: 'tcgplayer', marketCents: 90 })], 'USD')).toBeNull();
    expect(priceGap([], 'USD')).toBeNull();
  });
  it('never surfaces a zero amount', () => {
    expect(priceGap([row({ trendCents: 0, midCents: 0 })], 'USD')).toBeNull();
    expect(hasCurrencyPrice([row({ trendCents: 0 })], 'EUR')).toBe(false);
  });
});
