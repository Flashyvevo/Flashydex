import { describe, expect, it } from 'vitest';
import { convertCents, isCalendarDate, isFxStale, isValidFxRecord, parseRateExact, resolveFx, tryConvertCents, validateFxRecord, type FxRecord } from '../src/domain/fx';
import { MAX_CENTS } from '../src/domain/valuation';

const NOW = '2026-11-08T12:00:00.000Z';
const record = (over: Record<string, unknown> = {}): FxRecord => ({ base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-11-08T10:00:00.000Z', ...over }) as FxRecord;

/** Independent exact oracle: digits-only decimal parse, floor((2*c*n + d) / (2*d)), no floats, no shared code with fx.ts. null = exceeds MAX_CENTS. */
function oracle(cents: number, rate: string): number | null {
  const [whole, frac = ''] = rate.split('.');
  const n = BigInt(`${whole}${frac}`);
  const d = BigInt(`1${'0'.repeat(frac.length)}`);
  const out = (2n * BigInt(cents) * n + d) / (2n * d);
  return out > BigInt(MAX_CENTS) ? null : Number(out);
}

describe('parseRateExact', () => {
  it('keeps FULL precision as (unscaled, scale)', () => {
    expect(parseRateExact('1.1165')).toEqual({ unscaled: 11165n, scale: 4 });
    expect(parseRateExact('1')).toEqual({ unscaled: 1n, scale: 0 });
    expect(parseRateExact('0.000000000001')).toEqual({ unscaled: 1n, scale: 12 });
    expect(parseRateExact('1.11650049')).toEqual({ unscaled: 111650049n, scale: 8 });
    expect(parseRateExact('999.999999999999')).toEqual({ unscaled: 999999999999999n, scale: 12 });
  });
  it('rejects malformed, zero, negative, exponent, >12 digits, non-strings and rates outside (0,1000)', () => {
    for (const bad of ['', 'abc', '0', '0.0', '0.000000000000', '-1.2', '1e3', '1,1', ' 1.1', '1.', '.5', '1000', '1000.0', '1001', 'NaN', 'Infinity', '1.0000000000001']) expect(parseRateExact(bad), bad).toBeNull();
    for (const bad of [1.1, null, undefined, [], ['1.1'], {}]) expect(parseRateExact(bad)).toBeNull();
  });
});

describe('convertCents (exact decimal)', () => {
  it('hand-computed', () => {
    expect(convertCents(2140, '1.1165')).toBe(2389);
    expect(convertCents(100, '1.1165')).toBe(112);
    expect(convertCents(0, '1.1165')).toBe(0);
    expect(convertCents(1, '1.1165')).toBe(1);
    expect(convertCents(10_000, '1.0834')).toBe(10_834);
  });

  it('Sol R11-01 adversarial table matches the exact oracle (cents, rate, expected or null=overflow)', () => {
    const table: [number, string, number | null][] = [
      [2140, '1.1165', 2389], [1, '0.499999', 0], [1, '0.5', 1], [1, '0.500001', 1], [100, '0.005', 1], [99, '0.005', 0], [101, '0.005', 1],
      [1, '0.4999995', 0], [1_000_000, '1.0000004', 1_000_000], [1_000_000, '1.0000005', 1_000_001], [2147483647, '1', 2147483647],
      [2147483647, '0.999999', 2147481500], [2147483647, '0.9999999', 2147483432], [2147483647, '1.000000000001', 2147483647], [2147483647, '1.0000004', null],
      [1_000_001, '1.11650049', 1_116_502], [2147483647, '1.000001', null], [2147483647, '0.0000005', 1074]
    ];
    for (const [cents, rate, expected] of table) {
      expect(oracle(cents, rate), `oracle ${cents} x ${rate}`).toBe(expected);
      if (expected === null) expect(() => convertCents(cents, rate), `${cents} x ${rate}`).toThrow(RangeError);
      else expect(convertCents(cents, rate), `${cents} x ${rate}`).toBe(expected);
    }
  });

  it('ties and boundaries round half-up on the exact remainder', () => {
    expect(convertCents(1, '1.5')).toBe(2);
    expect(convertCents(1, '0.5')).toBe(1);
    expect(convertCents(3, '0.5')).toBe(2);
    expect(convertCents(5, '0.1')).toBe(1);
    expect(convertCents(4, '0.1')).toBe(0);
    expect(convertCents(1, '0.4999999999')).toBe(0);
    expect(convertCents(1, '0.5000000001')).toBe(1);
  });

  it('rate "1" and "0.999999" are exact', () => {
    for (const c of [0, 1, 99, 12345, MAX_CENTS]) expect(convertCents(c, '1')).toBe(c);
    expect(convertCents(MAX_CENTS, '0.999999')).toBe(2147481500);
  });

  it('property: 12-digit and short rates equal the exact oracle (seeded, no floats in the expectation)', () => {
    let seed = 987654321;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(rnd() * 10))).join('');
    for (let i = 0; i < 3000; i += 1) {
      const fracLen = 1 + Math.floor(rnd() * 12);
      const rate = `${Math.floor(rnd() * 3)}.${digits(fracLen)}`;
      if (parseRateExact(rate) === null) continue; // 0.000... all-zero
      const cents = rnd() < 0.2 ? MAX_CENTS - Math.floor(rnd() * 1000) : Math.floor(rnd() * 5_000_000);
      const expected = oracle(cents, rate);
      if (expected === null) expect(() => convertCents(cents, rate), `${cents} x ${rate}`).toThrow(RangeError);
      else expect(convertCents(cents, rate), `${cents} x ${rate}`).toBe(expected);
    }
  });

  it('overflow is judged on the EXACT result; invalid inputs throw', () => {
    expect(convertCents(MAX_CENTS, '1')).toBe(MAX_CENTS);
    expect(() => convertCents(MAX_CENTS, '1.0000004')).toThrow(RangeError);
    expect(() => convertCents(MAX_CENTS, '999')).toThrow(RangeError);
    expect(() => convertCents(-1, '1.1')).toThrow(RangeError);
    expect(() => convertCents(1.5, '1.1')).toThrow(RangeError);
    expect(() => convertCents(Number.MAX_SAFE_INTEGER + 2, '1.1')).toThrow(RangeError);
    expect(() => convertCents(100, 'garbage')).toThrow(RangeError);
    expect(tryConvertCents(MAX_CENTS, '2')).toBeNull();
    expect(tryConvertCents(100, '2')).toBe(200);
  });
});

describe('staleness', () => {
  it('stale only when the rate date is more than 7 days old', () => {
    expect(isFxStale(record({ rateDate: '2026-11-01' }), '2026-11-08T00:00:00.000Z')).toBe(false);
    expect(isFxStale(record({ rateDate: '2026-11-01' }), '2026-11-08T00:00:01.000Z')).toBe(true);
    expect(isFxStale(record({ rateDate: '2026-10-31' }), '2026-11-08T00:00:00.000Z')).toBe(true);
    expect(isFxStale(record({ rateDate: '2026-11-06' }), '2026-11-08T12:00:00.000Z')).toBe(false);
    expect(isFxStale(record({ rateDate: 'nope' }), '2026-11-08T00:00:00.000Z')).toBe(true);
  });
});

describe('strict record validation (R11-03)', () => {
  it('accepts a good record and returns a clean copy', () => {
    expect(validateFxRecord(record(), NOW)).toEqual(record());
    expect(validateFxRecord({ ...record(), extra: 1 }, NOW)).toEqual(record());
    expect(isValidFxRecord(record({ rateDate: '1999-01-04' }), NOW)).toBe(true);
    expect(isValidFxRecord(record({ rateDate: '2026-11-09' }), NOW)).toBe(true); // +1 day timezone tolerance
  });

  it('rejects every malformed case', () => {
    const bad: [string, unknown][] = [
      ['numeric rate', record({ rate: 1.1165 })], ['array rate', record({ rate: ['1.1165'] })], ['null rate', record({ rate: null })],
      ['zero rate', record({ rate: '0' })], ['rate 1000', record({ rate: '1000' })], ['exponent rate', record({ rate: '1e0' })], ['13 digit rate', record({ rate: '1.1234567890123' })],
      ['impossible calendar day', record({ rateDate: '2026-02-31' })], ['month 13', record({ rateDate: '2026-13-01' })], ['bad format', record({ rateDate: '06/11/2026' })],
      ['numeric date', record({ rateDate: 20261106 })], ['future rateDate', record({ rateDate: '2099-01-01' })], ['2 days ahead', record({ rateDate: '2026-11-10' })],
      ['before the euro', record({ rateDate: '1998-12-31' })], ['day before first ECB date', record({ rateDate: '1999-01-03' })],
      ['future fetchedAt', record({ fetchedAt: '2099-01-01T00:00:00.000Z' })], ['garbage fetchedAt', record({ fetchedAt: 'yesterday' })],
      ['numeric fetchedAt', record({ fetchedAt: 1762599600000 })], ['impossible fetchedAt', record({ fetchedAt: '2026-02-31T10:00:00.000Z' })], ['hour 25', record({ fetchedAt: '2026-11-07T25:00:00.000Z' })],
      ['wrong provider', record({ provider: 'ecb' })], ['wrong base', record({ base: 'USD' })], ['wrong quote', record({ quote: 'EUR' })],
      ['null', null], ['string', 'x'], ['array', []], ['number', 1]
    ];
    for (const [name, value] of bad) {
      expect(validateFxRecord(value, NOW), name).toBeNull();
      expect(isValidFxRecord(value, NOW), name).toBe(false);
    }
    expect(validateFxRecord(record(), 'not a clock')).toBeNull();
  });

  it('isCalendarDate round-trips real dates only', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
  });

  it('resolveFx treats invalid records as absent: there is no default rate', () => {
    expect(resolveFx(undefined, NOW)).toBeNull();
    expect(resolveFx({ get: () => null }, NOW)).toBeNull();
    expect(resolveFx({ get: () => record({ rate: '0' }) }, NOW)).toBeNull();
    expect(resolveFx({ get: () => record({ rate: 1.1 }) }, NOW)).toBeNull();
    expect(resolveFx({ get: () => record({ rateDate: '2026-02-31' }) }, NOW)).toBeNull();
    expect(resolveFx({ get: () => record({ rateDate: '2099-01-01' }) }, NOW)).toBeNull();
    expect(resolveFx({ get: () => record() }, NOW)).toEqual({ record: record(), stale: false });
  });
});
