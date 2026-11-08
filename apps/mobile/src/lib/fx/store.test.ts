import { describe, expect, it } from 'vitest';
import type { FxRecord } from '@flashydex/core';
import { FX_ATTEMPT_KEY, FX_STORAGE_KEY, FX_STORE_VERSION, FxStore, fxNeedsRefresh, readLastAttempt, readStoredFx, writeStoredFx } from './store';

const NOW = '2026-11-08T12:00:00.000Z';
const rec = (over: Record<string, unknown> = {}): FxRecord => ({ base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-11-08T10:00:00.000Z', ...over }) as FxRecord;
const stored = (record: unknown) => JSON.stringify({ v: 1, record });

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
    expect(readStoredFx(s, NOW)).toEqual(rec());
  });
  it('unknown version, corrupt JSON, invalid record and missing key all read as null (no default rate)', () => {
    expect(readStoredFx(memory(), NOW)).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: '{not json' }), NOW)).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 2, record: rec() }) }), NOW)).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: stored(rec({ rate: '0' })) }), NOW)).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: stored(rec({ provider: 'other' })) }), NOW)).toBeNull();
    expect(readStoredFx(memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 1 }) }), NOW)).toBeNull();
    expect(readStoredFx(null, NOW)).toBeNull();
  });
  it('every Sol R11-03 malformed record reads as absent AND is deleted; an unknown version is left alone', () => {
    const cases: [string, unknown][] = [
      ['numeric rate', rec({ rate: 1.1165 })], ['array rate', rec({ rate: ['1.1165'] })], ['bad calendar', rec({ rateDate: '2026-02-31' })],
      ['future rateDate', rec({ rateDate: '2099-01-01' })], ['future fetchedAt', rec({ fetchedAt: '2099-01-01T00:00:00.000Z' })], ['bad fetchedAt', rec({ fetchedAt: 'yesterday' })],
      ['pre-euro date', rec({ rateDate: '1998-01-01' })], ['rate 1000', rec({ rate: '1000' })], ['13 digit rate', rec({ rate: '1.1234567890123' })], ['null record', null]
    ];
    for (const [name, record] of cases) {
      const s = memory({ [FX_STORAGE_KEY]: stored(record) });
      expect(readStoredFx(s, NOW), name).toBeNull();
      expect(s.getItem(FX_STORAGE_KEY), `${name} deleted`).toBeNull();
    }
    const corrupt = memory({ [FX_STORAGE_KEY]: '{not json' });
    readStoredFx(corrupt, NOW);
    expect(corrupt.getItem(FX_STORAGE_KEY)).toBeNull();
    const newer = memory({ [FX_STORAGE_KEY]: JSON.stringify({ v: 2, record: rec() }) });
    readStoredFx(newer, NOW);
    expect(newer.getItem(FX_STORAGE_KEY)).not.toBeNull();
  });
  it('a throwing storage never throws out of the store', () => {
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(readStoredFx(boom, NOW)).toBeNull();
    expect(writeStoredFx(rec(), boom)).toBe(false);
  });
});

describe('FxStore', () => {
  it('serves the cached record synchronously as the core provider; only EUR→USD', () => {
    const s = new FxStore(memory({ [FX_STORAGE_KEY]: stored(rec()) }), NOW);
    expect(s.get('EUR', 'USD')).toEqual(rec());
    expect(s.get('USD' as never, 'EUR' as never)).toBeNull();
    expect(new FxStore(memory(), NOW).get('EUR', 'USD')).toBeNull();
  });
  it('a future-dated cached record is dropped at load, and a valid fetch then replaces it', () => {
    const storage = memory({ [FX_STORAGE_KEY]: stored(rec({ rateDate: '2099-01-01' })) });
    const s = new FxStore(storage, NOW);
    expect(s.get('EUR', 'USD')).toBeNull();
    expect(s.set(rec(), NOW)).toBe(true);
    expect(readStoredFx(storage, NOW)).toEqual(rec());
  });
  it('a held record that has become invalid (e.g. future vs the clock) never blocks a valid new one', () => {
    const s = new FxStore(memory(), '2099-06-01T00:00:00.000Z');
    expect(s.set(rec({ rateDate: '2099-05-30', fetchedAt: '2099-05-30T10:00:00.000Z' }), '2099-06-01T00:00:00.000Z')).toBe(true);
    // the clock is later corrected to the real date: the held record is "newer than now" yet the valid current one wins
    expect(s.set(rec({ rateDate: '2026-11-06' }), NOW)).toBe(true);
    expect(s.get('EUR', 'USD')?.rateDate).toBe('2026-11-06');
  });
  it('adopts newer records and notifies; ignores older ones and invalid ones', () => {
    const storage = memory();
    const s = new FxStore(storage, NOW);
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    expect(s.set(rec({ rateDate: '2026-11-05', rate: '1.10' }), NOW)).toBe(true);
    expect(s.set(rec({ rateDate: '2026-11-06' }), NOW)).toBe(true);
    expect(s.set(rec({ rateDate: '2026-11-04', rate: '9.9' }), NOW)).toBe(false);
    expect(s.set(rec({ rate: 'x' }), NOW)).toBe(false);
    expect(s.set(rec({ rate: 1.2 }), NOW)).toBe(false);
    expect(s.set(rec({ rateDate: '2099-01-01' }), NOW)).toBe(false);
    expect(s.get('EUR', 'USD')?.rateDate).toBe('2026-11-06');
    expect(calls).toBe(2);
    expect(readStoredFx(storage, NOW)?.rate).toBe('1.1165');
  });
  it('the same reference rate only refreshes fetchedAt, without notifying', () => {
    const s = new FxStore(memory(), NOW);
    s.set(rec(), NOW);
    let calls = 0;
    s.subscribe(() => { calls += 1; });
    expect(s.set(rec({ fetchedAt: '2026-11-08T11:00:00.000Z' }), NOW)).toBe(false);
    expect(calls).toBe(0);
    expect(s.get('EUR', 'USD')?.fetchedAt).toBe('2026-11-08T11:00:00.000Z');
  });
  it('the attempt stamp persists under its own key and survives a new store; a future stamp is discarded', () => {
    const storage = memory();
    new FxStore(storage, NOW).markAttempt(NOW);
    expect(storage.getItem(FX_ATTEMPT_KEY)).toBe(NOW);
    expect(new FxStore(storage, '2026-11-08T13:00:00.000Z').lastAttemptAt()).toBe(NOW);
    const future = memory({ [FX_ATTEMPT_KEY]: '2099-01-01T00:00:00.000Z' });
    expect(readLastAttempt(future, NOW)).toBeNull();
    expect(future.getItem(FX_ATTEMPT_KEY)).toBeNull();
    expect(readLastAttempt(memory({ [FX_ATTEMPT_KEY]: 'junk' }), NOW)).toBeNull();
  });
});

describe('fxNeedsRefresh', () => {
  it('no record → refresh; rate date within a day → no refresh', () => {
    expect(fxNeedsRefresh(null, '2026-11-08T10:00:00.000Z')).toBe(true);
    expect(fxNeedsRefresh(rec({ rateDate: '2026-11-07' }), '2026-11-08T00:00:00.000Z')).toBe(false);
  });
  it('older than a day → refresh, but not more often than every 6 hours (weekend: ECB publishes weekdays only)', () => {
    const r = rec({ rateDate: '2026-11-06', fetchedAt: '2026-11-08T08:00:00.000Z' });
    expect(fxNeedsRefresh(r, '2026-11-08T10:00:00.000Z')).toBe(false);
    expect(fxNeedsRefresh(r, '2026-11-08T14:00:01.000Z')).toBe(true);
    expect(fxNeedsRefresh({ ...rec({ rateDate: '2026-11-01' }), fetchedAt: 'garbage' }, '2026-11-08T10:00:00.000Z')).toBe(true);
  });
  it('attempts are throttled regardless of outcome: 6 h from the last attempt, with or without a record', () => {
    const attempt = '2026-11-08T10:00:00.000Z';
    expect(fxNeedsRefresh(null, '2026-11-08T15:59:59.000Z', attempt)).toBe(false);
    expect(fxNeedsRefresh(null, '2026-11-08T16:00:00.000Z', attempt)).toBe(true);
    const old = rec({ rateDate: '2026-10-01', fetchedAt: '2026-10-01T10:00:00.000Z' });
    expect(fxNeedsRefresh(old, '2026-11-08T12:00:00.000Z', attempt)).toBe(false);
    expect(fxNeedsRefresh(old, '2026-11-08T16:00:00.000Z', attempt)).toBe(true);
    expect(fxNeedsRefresh(old, '2026-11-08T12:00:00.000Z', null)).toBe(true);
  });
});
