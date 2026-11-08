import { describe, expect, it, vi } from 'vitest';
import { FX_ATTEMPT_KEY, FxStore } from '../lib/fx/store';
import { refreshFxIfNeeded } from './fx-hooks';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k), setItem: (k: string, v: string) => void m.set(k, v)
  } as Storage;
}

const REAL = '{"amount":1.0,"base":"EUR","date":"2026-11-06","rates":{"USD":1.1165}}';

describe('refreshFxIfNeeded throttling (R11-04)', () => {
  it('three failing refreshes make ONE network call; the attempt is persisted', async () => {
    const storage = memory();
    const store = new FxStore(storage, '2026-11-08T10:00:00.000Z');
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    let clock = Date.parse('2026-11-08T10:00:00.000Z');
    const now = () => new Date(clock).toISOString();
    for (let i = 0; i < 3; i += 1) {
      expect(await refreshFxIfNeeded({ store, fetchImpl, now })).toBe(false);
      clock += 60_000;
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(storage.getItem(FX_ATTEMPT_KEY)).toBe('2026-11-08T10:00:00.000Z');
    // a "restart" (new store over the same storage) is still throttled
    const restarted = new FxStore(storage, now());
    expect(await refreshFxIfNeeded({ store: restarted, fetchImpl, now })).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 6 h later a new attempt is allowed
    clock += 6 * 3_600_000;
    await refreshFxIfNeeded({ store: restarted, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('HTTP errors and garbage bodies also count as attempts', async () => {
    const store = new FxStore(memory(), '2026-11-08T10:00:00.000Z');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const now = () => '2026-11-08T10:00:00.000Z';
    await refreshFxIfNeeded({ store, fetchImpl, now });
    await refreshFxIfNeeded({ store, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers coalesce into one request; a success stores the record', async () => {
    const store = new FxStore(memory(), '2026-11-08T10:00:00.000Z');
    const fetchImpl = vi.fn(async () => new Response(REAL, { status: 200 })) as unknown as typeof fetch;
    const now = () => '2026-11-08T10:00:00.000Z';
    const results = await Promise.all([refreshFxIfNeeded({ store, fetchImpl, now }), refreshFxIfNeeded({ store, fetchImpl, now }), refreshFxIfNeeded({ store, fetchImpl, now })]);
    expect(results).toEqual([true, true, true]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.get('EUR', 'USD')?.rate).toBe('1.1165');
  });
});
