import { describe, expect, it } from 'vitest';
import { summariseSold } from '../src/pricing/sold-summary';
import type { MarketQuote, SoldRecord } from '../src/pricing/types';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const id = { language: 'en', cardId: 'base1-4', variant: 'holo', variantDetail: '' } as const;

function sale(priceCents: number, over: Partial<SoldRecord> = {}): SoldRecord {
  return {
    kind: 'verified-sale', provider: 'test', cardIdentity: id, condition: 'NM', graded: null, priceCents, currency: 'USD',
    shippingIncluded: 'unknown', soldAt: daysAgo(1), ...over
  };
}
const base = { windowDays: 30, now: NOW, outlier: 'iqr' } as const;

describe('summariseSold', () => {
  it('computes mean and median (odd and even n), rounded to cents', () => {
    const [odd] = summariseSold([sale(100), sale(200), sale(300)], base);
    expect(odd).toMatchObject({ n: 3, meanCents: 200, medianCents: 200, windowDays: 30, outlierRule: 'iqr', excludedTotal: 0 });
    const [even] = summariseSold([sale(100), sale(201), sale(300), sale(400)], base);
    expect(even).toMatchObject({ n: 4, meanCents: 250, medianCents: 251 }); // (201+300)/2=250.5 -> 251
  });

  it('excludes out-of-window, future and unparseable-date records and counts them', () => {
    const [s] = summariseSold([
      sale(100), sale(100, { soldAt: daysAgo(31) }), sale(100, { soldAt: daysAgo(30) }),
      sale(100, { soldAt: new Date(NOW.getTime() + 1000).toISOString() }), sale(100, { soldAt: 'not-a-date' }), sale(200, { soldAt: daysAgo(29.9) })
    ], base);
    expect(s?.n).toBe(2);
    expect(s?.excluded.outOfWindow).toBe(4); // 31d, exactly 30d (window is open at the start), future, invalid
    expect(s?.meanCents).toBe(150);
  });

  it('excludes bundles and reports them separately', () => {
    const [s] = summariseSold([sale(100), sale(100), sale(9999, { bundle: true })], base);
    expect(s).toMatchObject({ n: 2, meanCents: 100, excluded: { bundle: 1, outOfWindow: 0, outlier: 0 } });
  });

  it('separates graded records by company+grade and from raw; never mixes currencies', () => {
    const psa10 = { company: 'PSA', grade: '10' };
    const out = summariseSold([
      sale(100), sale(120),
      sale(50000, { graded: psa10 }), sale(52000, { graded: { company: 'psa', grade: '10' } }),
      sale(20000, { graded: { company: 'PSA', grade: '9' } }),
      sale(48000, { graded: { company: 'BGS', grade: '10' } }),
      sale(9000, { currency: 'EUR' })
    ], base);
    const get = (company: string | null, grade: string | null, currency = 'USD') =>
      out.find((s) => s.bucket.currency === currency && (s.bucket.graded?.company ?? null) === company && (s.bucket.graded?.grade ?? null) === grade);
    expect(out).toHaveLength(5);
    expect(get(null, null)).toMatchObject({ n: 2, meanCents: 110 });
    expect(get('PSA', '10')).toMatchObject({ n: 2, meanCents: 51000 }); // case-insensitive company
    expect(get('PSA', '9')?.meanCents).toBe(20000);
    expect(get('BGS', '10')?.meanCents).toBe(48000);
    expect(get(null, null, 'EUR')?.meanCents).toBe(9000);
  });

  it('IQR rule drops a high outlier and a low outlier', () => {
    const records = [100, 102, 104, 106, 108, 110, 5000, 1].map((p) => sale(p));
    const [s] = summariseSold(records, base);
    expect(s?.excluded.outlier).toBe(2);
    expect(s?.n).toBe(6);
    expect(s?.medianCents).toBe(105);
  });

  it('MAD rule drops outliers; MAD of zero keeps everything', () => {
    const [s] = summariseSold([100, 101, 102, 103, 104, 5000].map((p) => sale(p)), { ...base, outlier: 'mad' });
    expect(s).toMatchObject({ n: 5, outlierRule: 'mad', excluded: { outlier: 1, bundle: 0, outOfWindow: 0 } });
    const [flat] = summariseSold([100, 100, 100, 100, 900].map((p) => sale(p)), { ...base, outlier: 'mad' });
    expect(flat?.n).toBe(5);
  });

  it('does not trim with fewer than 4 points', () => {
    const [s] = summariseSold([sale(1), sale(100), sale(100000)], base);
    expect(s).toMatchObject({ n: 3, excluded: { outlier: 0 } });
  });

  it('returns n=0 with null stats when every record in a bucket is excluded', () => {
    const [s] = summariseSold([sale(100, { soldAt: daysAgo(90) })], base);
    expect(s).toMatchObject({ n: 0, meanCents: null, medianCents: null, excludedTotal: 1 });
    expect(summariseSold([], base)).toEqual([]);
  });

  it('is order-independent and does not mutate input', () => {
    const records = [300, 100, 200].map((p) => sale(p));
    const copy = structuredClone(records);
    expect(summariseSold(records, base)).toEqual(summariseSold([...records].reverse(), base));
    expect(records).toEqual(copy);
  });

  it('rejects a bad window', () => {
    expect(() => summariseSold([], { ...base, windowDays: 0 })).toThrow(RangeError);
  });

  it('never mixes listings into sales: runtime guard throws on any non-verified-sale record', () => {
    const listing = { ...sale(100), kind: 'listing-estimate' } as unknown as SoldRecord;
    expect(() => summariseSold([sale(100), listing], base)).toThrow(/not a verified sale/);
    expect(() => summariseSold([{ provider: 'x', priceCents: 1 } as unknown as SoldRecord], base)).toThrow(TypeError);
  });

  it('never mixes listings into sales: type-level (listing quotes are not SoldRecords)', () => {
    const quote: MarketQuote = {
      provider: 'tcgdex', cardIdentity: id, quoteType: 'market', kind: 'listing-estimate', currency: 'USD', cents: 1, observedAt: NOW.toISOString(), providerUpdatedAt: null
    };
    // @ts-expect-error a MarketQuote must not be accepted where verified sales are required
    expect(() => summariseSold([quote], base)).toThrow(TypeError);
    // @ts-expect-error a SoldRecord cannot be re-labelled as a listing
    const bad: SoldRecord = { ...sale(1), kind: 'listing-estimate' };
    expect(bad.kind).toBe('listing-estimate');
  });
});

describe('summariseSold input validation (R11-06)', () => {
  it('rejects an invalid or non-Date now', () => {
    expect(() => summariseSold([sale(100)], { ...base, now: new Date('nope') })).toThrow(RangeError);
    expect(() => summariseSold([sale(100)], { ...base, now: new Date(Number.NaN) })).toThrow(/valid Date/);
    expect(() => summariseSold([sale(100)], { ...base, now: 1762603200000 as unknown as Date })).toThrow(RangeError);
    expect(() => summariseSold([sale(100)], { ...base, now: undefined as unknown as Date })).toThrow(RangeError);
  });
  it('rejects negative, NaN, infinite, fractional and non-number cents', () => {
    for (const bad of [-100, Number.NaN, Number.POSITIVE_INFINITY, 10.5, '100' as unknown as number, null as unknown as number, undefined as unknown as number]) {
      expect(() => summariseSold([sale(100), sale(bad)], base), String(bad)).toThrow(RangeError);
    }
    expect(summariseSold([sale(0), sale(100)], base)[0]).toMatchObject({ n: 2, meanCents: 50 });
  });
  it('rejects mixed identities: card id, language, variant, variantDetail', () => {
    const other = (over: Partial<SoldRecord['cardIdentity']>) => sale(100, { cardIdentity: { ...id, ...over } });
    expect(() => summariseSold([sale(100), other({ cardId: 'base1-5' })], base)).toThrow(/different card identity/);
    expect(() => summariseSold([sale(100), other({ language: 'ja' })], base)).toThrow(TypeError);
    expect(() => summariseSold([sale(100), other({ variant: 'normal' })], base)).toThrow(TypeError);
    expect(() => summariseSold([sale(100), other({ variantDetail: 'shadowless' })], base)).toThrow(TypeError);
  });
  it('a homogeneous set and an empty set still work', () => {
    expect(summariseSold([sale(100), sale(300)], base)[0]).toMatchObject({ n: 2, meanCents: 200 });
    expect(summariseSold([], base)).toEqual([]);
  });
});
