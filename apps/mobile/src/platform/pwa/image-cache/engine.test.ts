// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createImageEngine } from './engine';
import { readBounded } from './read-bounded';
import { createFakeCache, createFakeStore, plainLock, bytesOf, type FaultPlan } from './test-fakes';
import type { EngineLimits } from './types';

const LIMITS: EngineLimits = { min: 100, default: 1000, max: 5000, perEntryMax: 400 };
const u = (n: number | string) => `https://assets.tcgdex.net/en/base1/${n}/low.webp`;

function setup(over: { plan?: FaultPlan; limit?: number } = {}) {
  const plan: FaultPlan = over.plan ?? {};
  const cache = createFakeCache(plan);
  const store = createFakeStore(plan);
  let clock = 1_000;
  const make = () =>
    createImageEngine({ cache, store, lock: plainLock(), limits: LIMITS, now: () => ++clock, touchDebounceMs: 0 });
  const engine = make();
  // The invariant must hold at EVERY ledger write, not just at the end.
  store.onWrite = (entries) => {
    const sum = entries.reduce((a, e) => a + e.bytes, 0);
    if (sum > (store.limit ?? LIMITS.default)) throw new Error(`cap breached: ${sum} > ${store.limit ?? LIMITS.default}`);
  };
  return { cache, store, engine, make, plan, tick: () => clock };
}

const admit = (e: ReturnType<typeof createImageEngine>, url: string, n: number) =>
  e.admit({ url, body: bytesOf(n), contentType: 'image/webp' });

describe('image ledger engine', () => {
  it('stores, counts and reports stats', async () => {
    const { engine, cache } = setup();
    expect((await admit(engine, u(1), 300)).stored).toBe(true);
    const s = await engine.stats();
    expect(s).toMatchObject({ enforced: true, limitBytes: 1000, committedBytes: 300, reservedBytes: 0, entries: 1, reason: null });
    expect(await cache.keys()).toEqual([u(1)]);
  });

  it('never exceeds the cap under 40 concurrent admissions (checked at every ledger write)', async () => {
    const { engine, store, cache } = setup();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => admit(engine, u(i), 100 + (i % 3) * 50)));
    expect(results.every((r) => r.stored)).toBe(true);
    const s = await engine.stats();
    expect(s.committedBytes + s.reservedBytes).toBeLessThanOrEqual(1000);
    expect(store.peak).toBeLessThanOrEqual(1000);
    expect((await cache.keys()).length).toBe(s.entries);
    expect(s.reservedBytes).toBe(0);
  });

  it('evicts least recently used first and honours touches', async () => {
    const { engine, cache } = setup();
    for (const i of [1, 2, 3]) await admit(engine, u(i), 300); // 900
    await engine.touch(u(1)); // 1 is now newest; 2 is oldest
    await admit(engine, u(4), 300); // needs 200 freed -> evict 2
    expect((await cache.keys()).sort()).toEqual([u(1), u(3), u(4)].sort());
    await admit(engine, u(5), 300); // evict 3
    expect((await cache.keys()).sort()).toEqual([u(1), u(4), u(5)].sort());
  });

  it('bypasses oversized entries and entries bigger than the whole limit', async () => {
    const { engine } = setup();
    expect((await admit(engine, u('big'), 401)).reason).toBe('oversized');
    await engine.setLimit(100); // clamp min 100
    expect((await admit(engine, u('big2'), 150)).stored).toBe(false);
    expect((await engine.stats()).entries).toBe(0);
  });

  it('replacement subtracts the old charge only once the old entry is deleted', async () => {
    const { engine, cache } = setup();
    await admit(engine, u(1), 300);
    await admit(engine, u(1), 200);
    const s = await engine.stats();
    expect(s.committedBytes).toBe(200);
    expect(s.entries).toBe(1);
    expect((await cache.keys()).length).toBe(1);
  });

  it('setLimit clamps, persists, and evicts BEFORE resolving', async () => {
    const { engine, cache, store } = setup();
    for (const i of [1, 2, 3, 4]) await admit(engine, u(i), 250); // 1000
    const s = await engine.setLimit(500);
    expect(s.limitBytes).toBe(500);
    expect(s.committedBytes).toBeLessThanOrEqual(500);
    expect((await cache.keys()).length).toBe(2);
    expect(store.limit).toBe(500);
    expect((await engine.setLimit(1)).limitBytes).toBe(LIMITS.min);
    expect((await engine.setLimit(10 ** 12)).limitBytes).toBe(LIMITS.max);
  });

  it('clear removes every image and ledger row, and re-enables admissions', async () => {
    const { engine, cache, store } = setup();
    await admit(engine, u(1), 100);
    await admit(engine, u(2), 100);
    const s = await engine.clear();
    expect(s.entries).toBe(0);
    expect(s.committedBytes).toBe(0);
    expect(await cache.keys()).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect((await admit(engine, u(3), 100)).stored).toBe(true);
  });

  describe('crash + reconcile', () => {
    for (const step of ['reserve', 'put', 'commit'] as const) {
      it(`crash at ${step}: a fresh engine reconciles before admitting`, async () => {
        const plan: FaultPlan = {};
        const { engine, make, cache, store } = setup({ plan });
        await admit(engine, u('keep'), 200);
        plan.crashAt = step; // the process "dies" during the next admission
        await admit(engine, u('victim'), 300).catch(() => undefined);
        plan.crashAt = undefined;
        plan.dead = false; // restarted worker
        const fresh = make();
        const s = await fresh.stats(); // reconciles first
        expect(s.reservedBytes).toBe(0);
        const rows = [...store.rows.values()];
        expect(rows.every((r) => r.state === 'committed')).toBe(true);
        // ledger and cache describe exactly the same set, no pending, no orphan
        expect((await cache.keys()).sort()).toEqual(rows.map((r) => r.url).sort());
        expect(rows.some((r) => r.url === u('keep'))).toBe(true);
        expect(rows.some((r) => r.url === u('victim'))).toBe(false); // uncommitted bytes are removed, not trusted
        expect(s.committedBytes).toBe(rows.reduce((a, r) => a + r.bytes, 0));
      });
    }

    it('drops metadata without a cache entry and deletes untracked cache entries; evicts to cap first', async () => {
      const { engine, make, cache, store } = setup();
      await admit(engine, u(1), 300);
      await admit(engine, u(2), 300);
      await cache.delete(u(1)); // cache lost an entry (user cleared / browser eviction)
      await cache.put(u('orphan'), new Response(bytesOf(50))); // untracked
      store.limit = 200; // limit shrank while SW was dead
      const fresh = make();
      const s = await fresh.stats();
      expect(await cache.keys()).toEqual([]); // u(2)=300 > 200 evicted, orphan removed, u(1) dropped
      expect(s.committedBytes).toBe(0);
      expect(store.rows.size).toBe(0);
    });

    it('does not admit before reconcile finishes (reconcile runs first on first admit)', async () => {
      const { engine, make, cache, store } = setup();
      for (const i of [1, 2, 3]) await admit(engine, u(i), 300);
      store.rows.set(u('ghost'), { url: u('ghost'), bytes: 300, lastAccess: 1, storedAt: 1, state: 'pending' });
      await cache.put(u('ghost'), new Response(bytesOf(300)));
      const fresh = make();
      await admit(fresh, u(9), 300);
      expect(store.rows.has(u('ghost'))).toBe(false);
      expect(await cache.has(u('ghost'))).toBe(false);
      expect(store.peak).toBeLessThanOrEqual(1000);
    });
  });

  describe('quota', () => {
    it('retries once after reconcile and succeeds', async () => {
      const plan: FaultPlan = { quotaOnPuts: 1 };
      const { engine } = setup({ plan });
      const r = await admit(engine, u(1), 100);
      expect(r.stored).toBe(true);
      expect(plan.putCalls).toBe(2);
    });

    it('retries once then disables admissions (app unaffected, stats say so)', async () => {
      const plan: FaultPlan = { quotaOnPuts: 99 };
      const { engine, store, cache } = setup({ plan });
      const r = await admit(engine, u(1), 100);
      expect(r).toMatchObject({ stored: false, reason: 'quota' });
      expect(plan.putCalls).toBe(2);
      const again = await admit(engine, u(2), 100);
      expect(again.reason).toBe('disabled');
      expect(plan.putCalls).toBe(2); // no further attempts
      const s = await engine.stats();
      expect(s.lastError).toMatch(/quota/i);
      expect(s.reservedBytes).toBe(0);
      expect(store.rows.size).toBe(0);
      expect(await cache.keys()).toEqual([]);
    });
  });

  describe('TTL', () => {
    it('reports stale after 30 days and markFresh restarts the clock', async () => {
      const cache = createFakeCache({});
      const store = createFakeStore({});
      let t = 1_000;
      const engine = createImageEngine({ cache, store, lock: plainLock(), limits: LIMITS, now: () => t, touchDebounceMs: 0 });
      await admit(engine, u(1), 100);
      expect((await engine.lookup(u(1)))?.stale).toBe(false);
      t += 29 * 86_400_000;
      expect((await engine.lookup(u(1)))?.stale).toBe(false);
      t += 2 * 86_400_000;
      expect((await engine.lookup(u(1)))?.stale).toBe(true);
      await engine.markFresh(u(1));
      expect((await engine.lookup(u(1)))?.stale).toBe(false);
    });

    it('a touch survives in the ledger after the debounce', async () => {
      const { engine, store } = setup();
      await admit(engine, u(1), 100);
      const before = store.rows.get(u(1))!.lastAccess;
      await engine.lookup(u(1));
      await engine.touch(u(1));
      expect(store.rows.get(u(1))!.lastAccess).toBeGreaterThan(before);
    });
  });
});

describe('readBounded', () => {
  const resp = (body: BodyInit, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

  it('reads a normal body', async () => {
    const r = await readBounded(resp(bytesOf(10)), 100);
    expect(r.ok && r.body.byteLength).toBe(10);
  });
  it('ignores a lying small Content-Length and stops at the cap', async () => {
    const r = await readBounded(resp(bytesOf(500), { 'content-length': '5' }), 100);
    expect(r).toEqual({ ok: false, reason: 'oversized' });
  });
  it('ignores a missing Content-Length (streamed body)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytesOf(60));
      }
    });
    const r = await readBounded(new Response(stream), 100);
    expect(r).toEqual({ ok: false, reason: 'oversized' });
  });
  it('does not reject on a huge declared Content-Length when the body is small', async () => {
    const r = await readBounded(resp(bytesOf(10), { 'content-length': '99999999' }), 100);
    expect(r.ok).toBe(true);
  });
  it('accepts exactly the cap and rejects cap+1', async () => {
    expect((await readBounded(resp(bytesOf(100)), 100)).ok).toBe(true);
    expect((await readBounded(resp(bytesOf(101)), 100)).ok).toBe(false);
  });
});
