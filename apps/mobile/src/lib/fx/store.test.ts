import { describe, expect, it } from 'vitest';
import type { FxRecord } from '@flashydex/core';
import { FX_STORAGE_KEY, FX_STORE_VERSION, FxStore, fxNeedsRefresh, readStoredFx, writeStoredFx } from './store';

const rec = (over: Partial<FxRecord> = {}): FxRecord => ({ base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-11-08T10:00:00.000Z', ...over });

function memory(initial: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k), setItem: (k: string, v: string) => void m.set(k, v)
  } as Storage;
}

describe('fx store persistence', () => {
  it('round-trips a versioned record under fdx.fx.EURUSD', () => {
    const s = memory();
    expect(writeStoredFx(rec(), s)).toBe(true);
    expect(JSON.parse(s.getItem(FX_STORAGE_KEY) as string)).toEqual({ v: FX_STORE_VERSION, record: rec() });
    expect(readStoredFx(s)).toEqual(rec());
  });
  it('unknown version, corrupt JSON, invalid record and missing key all read as null (no default rate)', () => {
    expect(readStoredFx(memory())).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: '{not json' }))).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 2, record: rec() }) }))).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 1, record: rec({ rate: '0' }) }) }))).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 1, record: { ...rec(), provider: 'other' } }) }))).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 1 }) }))).toBeNull();
    expect(readStoredFx(null)).toBeNull();
  });
  it('a throwing storage never throws out of the store', () => {
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(readStoredFx(boom)).toBeNull();
    expect(writeStoredFx(rec(), boom)).toBe(false);
  });
});

describe('FxStore', () => {
  it('serves the cached record synchronously as the core provider; only EUR→USD', () => {
    const s = new FxStore(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 1, record: rec() }) }));
    expect(s.get('EUR', 'USD')).toEqual(rec());
    expect(s.get('USD' as never, 'EUR' as never)).toBeNull();
    expect(new FxStore(memory()).get('EUR', 'USD')).toBeNull();
  });
  it('adopts newer records and notifies; ignores older ones and invalid ones', () => {
    const storage = memory();
    const s = new FxStore(storage);
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    expect(s.set(rec({ rateDate: '2026-11-05', rate: '1.10' }))).toBe(true);
    expect(s.set(rec({ rateDate: '2026-11-06' }))).toBe(true);
    expect(s.set(rec({ rateDate: '2026-11-04', rate: '9.9' }))).toBe(false);
    expect(s.set(rec({ rate: 'x' }))).toBe(false);
    expect(s.get('EUR', 'USD')?.rateDate).toBe('2026-11-06');
    expect(calls).toBe(2);
    expect(readStoredFx(storage)?.rate).toBe('1.1165');
  });
  it('the same reference rate only refreshes fetchedAt, without notifying', () => {
    const s = new FxStore(memory());
    s.set(rec());
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    expect(s.set(rec({ fetchedAt: '2026-11-09T10:00:00.000Z' }))).toBe(false);
    expect(calls).toBe(0);
    expect(s.get('EUR', 'USD')?.fetchedAt).toBe('2026-11-09T10:00:00.000Z');
  });
});

describe('fxNeedsRefresh', () => {
  it('no record → refresh; rate date within a day → no refresh', () => {
    expect(fxNeedsRefresh(null, '2026-11-08T10:00:00.000Z')).toBe(true);
    expect(fxNeedsRefresh(rec({ rateDate: '2026-11-07' }), '2026-11-08T00:00:00.000Z')).toBe(false);
  });
  it('older than a day → refresh, but not more than every 6 hours (weekend: ECB publishes weekdays only)', () => {
    const r = rec({ rateDate: '2026-11-06', fetchedAt: '2026-11-08T08:00:00.000Z' });
    expect(fxNeedsRefresh(r, '2026-11-08T10:00:00.000Z')).toBe(false);
    expect(fxNeedsRefresh(r, '2026-11-08T14:00:01.000Z')).toBe(true);
    expect(fxNeedsRefresh(rec({ rateDate: '2026-11-01', fetchedAt: 'garbage' }), '2026-11-08T10:00:00.000Z')).toBe(true);
  });
});
