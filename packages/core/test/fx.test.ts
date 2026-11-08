import { describe, expect, it } from 'vitest';
import { convertCents, isFxStale, isValidFxRecord, parseRateScaled, resolveFx, tryConvertCents, type FxRecord } from '../src/domain/fx';
import { MAX_CENTS } from '../src/domain/valuation';

const record = (over: Partial<FxRecord> = {}): FxRecord => ({ base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-11-08T10:00:00.000Z', ...over });

describe('parseRateScaled', () => {
  it('scales to 6 fractional digits', () => {
    expect(parseRateScaled('1.1165')).toBe(1_116_500n);
    expect(parseRateScaled('1')).toBe(1_000_000n);
    expect(parseRateScaled('0.000001')).toBe(1n);
    expect(parseRateScaled('12.345678')).toBe(12_345_678n);
  });
  it('rounds half-up beyond 6 digits', () => {
    expect(parseRateScaled('1.0000004')).toBe(1_000_000n);
    expect(parseRateScaled('1.0000005')).toBe(1_000_001n);
  });
  it('rejects malformed, zero, negative, exponent and implausible rates', () => {
    for (const bad of ['', 'abc', '0', '0.0', '-1.2', '1e3', '1,1', ' 1.1', '1.', '.5', '1001', '99999', 'NaN', 'Infinity']) expect(parseRateScaled(bad), bad).toBeNull();
  });
});

describe('convertCents', () => {
  it('exact conversion, hand-computed', () => {
    expect(convertCents(2140, '1.1165')).toBe(2389); // 2389.31
    expect(convertCents(100, '1.1165')).toBe(112); // 111.65
    expect(convertCents(0, '1.1165')).toBe(0);
    expect(convertCents(1, '1.1165')).toBe(1);
    expect(convertCents(10_000, '1.0834')).toBe(10_834);
  });

  it('rounds half-up at exact ties, deterministically', () => {
    expect(convertCents(1, '1.5')).toBe(2); // 1.5 -> 2
    expect(convertCents(1, '0.5')).toBe(1); // 0.5 -> 1
    expect(convertCents(3, '0.5')).toBe(2); // 1.5 -> 2
    expect(convertCents(1, '0.499999')).toBe(0);
    expect(convertCents(5, '0.1')).toBe(1); // 0.5 -> 1
    expect(convertCents(4, '0.1')).toBe(0); // 0.4 -> 0
  });

  it('property: |result - exact| <= 0.5 cent, monotonic in cents and rate, tie goes up (seeded)', () => {
    let seed = 123456789;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 2000; i += 1) {
      const cents = Math.floor(rnd() * 1_000_000);
      const rateThousandths = 1 + Math.floor(rnd() * 3000); // 0.001 .. 3.000, 3 decimals => exact in 1e6 scale
      const rate = (rateThousandths / 1000).toFixed(3);
      const out = convertCents(cents, rate);
      const exactTimes1000 = cents * rateThousandths; // exact integer arithmetic: value * 1000
      const diff = Math.abs(out * 1000 - exactTimes1000);
      expect(diff).toBeLessThanOrEqual(500);
      if (diff === 500) expect(out * 1000).toBeGreaterThan(exactTimes1000); // exact tie rounds up
      expect(convertCents(cents + 1, rate)).toBeGreaterThanOrEqual(out);
      expect(convertCents(cents, (rateThousandths / 1000 + 0.001).toFixed(3))).toBeGreaterThanOrEqual(out);
      expect(convertCents(cents, rate)).toBe(out); // deterministic
    }
  });

  it('overflow: results above MAX_CENTS and unsafe inputs throw RangeError; MAX_CENTS at rate 1 is allowed', () => {
    expect(convertCents(MAX_CENTS, '1')).toBe(MAX_CENTS);
    expect(() => convertCents(MAX_CENTS, '1.000001')).toThrow(RangeError);
    expect(() => convertCents(MAX_CENTS, '999')).toThrow(RangeError);
    expect(() => convertCents(-1, '1.1')).toThrow(RangeError);
    expect(() => convertCents(1.5, '1.1')).toThrow(RangeError);
    expect(() => convertCents(Number.MAX_SAFE_INTEGER + 2, '1.1')).toThrow(RangeError);
    expect(() => convertCents(100, 'garbage')).toThrow(RangeError);
    expect(tryConvertCents(MAX_CENTS, '2')).toBeNull();
    expect(tryConvertCents(100, '2')).toBe(200);
  });
});

describe('staleness and validity', () => {
  it('stale only when the rate date is more than 7 days old', () => {
    expect(isFxStale(record({ rateDate: '2026-11-01' }), '2026-11-08T00:00:00.000Z')).toBe(false); // exactly 7 days
    expect(isFxStale(record({ rateDate: '2026-11-01' }), '2026-11-08T00:00:01.000Z')).toBe(true);
    expect(isFxStale(record({ rateDate: '2026-10-31' }), '2026-11-08T00:00:00.000Z')).toBe(true);
    expect(isFxStale(record({ rateDate: '2026-11-06' }), '2026-11-08T12:00:00.000Z')).toBe(false);
    expect(isFxStale(record({ rateDate: 'nope' }), '2026-11-08T00:00:00.000Z')).toBe(true);
  });

  it('invalid records are treated as absent: there is no default rate', () => {
    expect(resolveFx(undefined, '2026-11-08T00:00:00.000Z')).toBeNull();
    expect(resolveFx({ get: () => null }, '2026-11-08T00:00:00.000Z')).toBeNull();
    expect(resolveFx({ get: () => record({ rate: '0' }) }, '2026-11-08T00:00:00.000Z')).toBeNull();
    expect(resolveFx({ get: () => record({ rateDate: '06/11/2026' }) }, '2026-11-08T00:00:00.000Z')).toBeNull();
    expect(isValidFxRecord(record())).toBe(true);
    expect(resolveFx({ get: () => record() }, '2026-11-08T00:00:00.000Z')).toEqual({ record: record(), stale: false });
  });
});
