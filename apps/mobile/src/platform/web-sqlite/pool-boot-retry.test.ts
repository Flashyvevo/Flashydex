// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WebStorageError } from '../web-storage/contract';
import {
  backoffDelayMs, installPoolWithRetry, isTransientPoolOpenError, POOL_BOOT_BACKOFF_CAP_MS, POOL_BOOT_BACKOFF_START_MS, POOL_BOOT_BUDGET_MS, PoolOpenFailure,
  withPoolOpenRetry, type PoolInstallOptions
} from './pool-boot-retry';
import { fromWire, wireError } from './protocol';

const domException = (name: string, message = name) => Object.assign(new Error(message), { name });

/** A virtual clock: `sleep` advances it, so budget behaviour is deterministic and instant. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
}
const noJitter = { random: () => 0.5 };

describe('boot pool-open retry policy (S6-02)', () => {
  it('defaults: 15 s elapsed budget, backoff 250 ms -> 2 s cap', () => {
    expect([POOL_BOOT_BUDGET_MS, POOL_BOOT_BACKOFF_START_MS, POOL_BOOT_BACKOFF_CAP_MS]).toEqual([15_000, 250, 2_000]);
  });

  it('backoff is exponential, capped, and jittered within +/-25%', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => backoffDelayMs(n, noJitter))).toEqual([250, 500, 1000, 2000, 2000, 2000]);
    expect(backoffDelayMs(1, { random: () => 0 })).toBe(188);
    expect(backoffDelayMs(1, { random: () => 1 })).toBe(313);
    expect(backoffDelayMs(9, { random: () => 1 })).toBe(2000); // never above the cap
  });

  it('classifies: handle-still-held and unclassified open failures are transient; quota, capacity and engine errors are not', () => {
    expect(isTransientPoolOpenError(domException('NoModificationAllowedError'))).toBe(true);
    expect(isTransientPoolOpenError(domException('InvalidStateError'))).toBe(true);
    expect(isTransientPoolOpenError(new Error('Access Handles cannot be created'))).toBe(true);
    expect(isTransientPoolOpenError(new WebStorageError('INIT_FAILED', 'x'))).toBe(true);
    expect(isTransientPoolOpenError(domException('QuotaExceededError'))).toBe(false);
    expect(isTransientPoolOpenError(new WebStorageError('CAPACITY', 'x'))).toBe(false);
    expect(isTransientPoolOpenError(new WebStorageError('QUOTA', 'x'))).toBe(false);
    expect(isTransientPoolOpenError(Object.assign(new Error('file is not a database'), { name: 'SQLite3Error', resultCode: 26 }))).toBe(false);
  });

  it('retries transient failures until success; attempt 1 is never forced, every later attempt is', async () => {
    const c = clock();
    const contexts: { attempt: number; force: boolean }[] = [];
    const result = await withPoolOpenRetry(async (ctx) => {
      contexts.push({ attempt: ctx.attempt, force: ctx.force });
      if (ctx.attempt < 4) throw domException('NoModificationAllowedError');
      return 'pool';
    }, { ...noJitter, now: c.now, sleep: c.sleep });
    expect(result).toBe('pool');
    expect(contexts).toEqual([{ attempt: 1, force: false }, { attempt: 2, force: true }, { attempt: 3, force: true }, { attempt: 4, force: true }]);
    expect(c.sleeps).toEqual([250, 500, 1000]);
  });

  it('gives up when the ELAPSED budget cannot cover the next backoff (not after a fixed count); records every attempt with cause + elapsed', async () => {
    const c = clock();
    const error = await withPoolOpenRetry(async () => { c.advance(100); throw domException('NoModificationAllowedError', 'Access handle held'); }, { ...noJitter, now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PoolOpenFailure);
    const failure = error as PoolOpenFailure;
    expect(failure.exhausted).toBe(true);
    expect(failure.attempts.length).toBeGreaterThan(8);
    expect(failure.attempts[0]).toMatchObject({ attempt: 1, force: false, code: 'BUSY', cause: 'NoModificationAllowedError: Access handle held', elapsedMs: 100 });
    expect(failure.attempts[1]).toMatchObject({ attempt: 2, force: true, elapsedMs: 450 });
    const last = failure.attempts[failure.attempts.length - 1] as { elapsedMs: number };
    expect(last.elapsedMs).toBeLessThan(POOL_BOOT_BUDGET_MS);
    expect(last.elapsedMs).toBeGreaterThan(POOL_BOOT_BUDGET_MS - 2_500);
    expect((failure.lastError as Error).name).toBe('NoModificationAllowedError');
  });

  it('never retries quota, capacity or corruption: one attempt, immediate PoolOpenFailure carrying the original error', async () => {
    for (const failure of [domException('QuotaExceededError'), new WebStorageError('CAPACITY', 'x'), Object.assign(new Error('malformed'), { name: 'SQLite3Error', resultCode: 11 })]) {
      let calls = 0;
      const c = clock();
      const error = await withPoolOpenRetry(async () => { calls += 1; throw failure; }, { now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
      expect(calls).toBe(1);
      expect(c.sleeps).toEqual([]);
      expect(error).toBeInstanceOf(PoolOpenFailure);
      expect((error as PoolOpenFailure).exhausted).toBe(false);
      expect((error as PoolOpenFailure).lastError).toBe(failure);
    }
  });

  it('a first-try success never sleeps; onRetry sees each failed attempt and the delay that follows', async () => {
    const c = clock();
    expect(await withPoolOpenRetry(async () => 1, { now: c.now, sleep: c.sleep })).toBe(1);
    expect(c.sleeps).toEqual([]);
    const seen: Array<[number, number]> = [];
    let calls = 0;
    await withPoolOpenRetry(async () => { calls += 1; if (calls < 3) throw new Error('busy'); return 1; }, { ...noJitter, now: c.now, sleep: c.sleep, onRetry: (a, d) => seen.push([a.attempt, d]) });
    expect(seen).toEqual([[1, 250], [2, 500]]);
  });
});

/**
 * A stand-in for the PINNED installOpfsSAHPoolVfs (dist/index.mjs ~17228-17296): it caches the init promise per VFS name, and a cached
 * REJECTION is returned again unless `forceReinitIfPreviouslyFailed` is set. `held` models a sync access handle still owned elsewhere.
 */
function pinnedInstaller(state: { held: boolean }) {
  const cache = new Map<string, Promise<{ reserveMinimumCapacity(n: number): Promise<number> }>>();
  const calls: PoolInstallOptions[] = [];
  let acquires = 0;
  const install = async (options: PoolInstallOptions) => {
    calls.push({ ...options });
    const cached = cache.get(options.name);
    if (cached) {
      try {
        return await cached;
      } catch (e) {
        if (options.forceReinitIfPreviouslyFailed) cache.delete(options.name);
        else throw e;
      }
    }
    acquires += 1; // a REAL attempt to take the handles
    const attempt = (async () => {
      if (state.held) throw domException('NoModificationAllowedError', 'Access Handles cannot be created');
      return { reserveMinimumCapacity: async (n: number) => n };
    })();
    attempt.catch(() => undefined);
    cache.set(options.name, attempt);
    return attempt;
  };
  return { install, calls, acquires: () => acquires };
}

describe('installPoolWithRetry against the pinned initializer semantics (S6-02)', () => {
  const base = { name: 'opfs-sahpool', directory: '/flashydex-sqlite-v1', initialCapacity: 16 };

  it('after one failure the second attempt is really invoked WITH force and succeeds once the held handle is released', async () => {
    const state = { held: true };
    const spy = pinnedInstaller(state);
    const c = clock();
    const util = await installPoolWithRetry(spy.install, base, { ...noJitter, now: c.now, sleep: async (ms) => { await c.sleep(ms); state.held = false; } });
    expect(util).toBeDefined();
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[0]).not.toHaveProperty('forceReinitIfPreviouslyFailed');
    expect(spy.calls[1]).toMatchObject({ forceReinitIfPreviouslyFailed: true });
    expect(spy.acquires()).toBe(2); // the second call touched OPFS again, it was not served from the cached rejection
    for (const call of spy.calls) expect(call).toMatchObject({ clearOnInit: false, preserveOnInitFailure: true, name: 'opfs-sahpool', directory: '/flashydex-sqlite-v1', initialCapacity: 16 });
  });

  it('red proof: WITHOUT force the pinned cache replays the first failure forever (what the old loop did)', async () => {
    const state = { held: true };
    const spy = pinnedInstaller(state);
    await expect(spy.install({ ...base, clearOnInit: false, preserveOnInitFailure: true })).rejects.toThrow('Access Handles');
    state.held = false;
    await expect(spy.install({ ...base, clearOnInit: false, preserveOnInitFailure: true })).rejects.toThrow('Access Handles'); // handle released, still cached
    expect(spy.acquires()).toBe(1);
  });

  it('first attempt success: one call, no force, no sleep', async () => {
    const spy = pinnedInstaller({ held: false });
    const c = clock();
    await installPoolWithRetry(spy.install, base, { now: c.now, sleep: c.sleep });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).not.toHaveProperty('forceReinitIfPreviouslyFailed');
    expect(c.sleeps).toEqual([]);
  });

  it('a handle that never frees exhausts the elapsed budget with every attempt recorded (forced after the first)', async () => {
    const spy = pinnedInstaller({ held: true });
    const c = clock();
    const error = await installPoolWithRetry(spy.install, base, { ...noJitter, now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PoolOpenFailure);
    const f = error as PoolOpenFailure;
    expect(f.exhausted).toBe(true);
    expect(f.attempts.map((a) => a.force)).toEqual(f.attempts.map((_, i) => i > 0));
    expect(spy.acquires()).toBe(f.attempts.length); // each retry really re-acquired
  });

  it('quota from install or from reserveMinimumCapacity fails at once: one call, no retry', async () => {
    let calls = 0;
    const c = clock();
    await expect(installPoolWithRetry(async () => { calls += 1; throw domException('QuotaExceededError'); }, base, { now: c.now, sleep: c.sleep })).rejects.toBeInstanceOf(PoolOpenFailure);
    expect(calls).toBe(1);
    calls = 0;
    await expect(installPoolWithRetry(async () => { calls += 1; return { reserveMinimumCapacity: async () => { throw domException('QuotaExceededError'); } }; }, base, { now: c.now, sleep: c.sleep })).rejects.toBeInstanceOf(PoolOpenFailure);
    expect(calls).toBe(1);
    expect(c.sleeps).toEqual([]);
  });
});

describe('per-attempt causes travel with INIT_FAILED (S6-02)', () => {
  it('wireError/fromWire keep attempts (and only the documented fields)', () => {
    const attempts = [{ attempt: 1, force: false, code: 'INIT_FAILED', cause: 'NoModificationAllowedError: held', elapsedMs: 12, secret: 'x' } as never];
    const wire = wireError(new WebStorageError('INIT_FAILED', 'The browser storage pool could not be opened', { attempts } as never));
    expect(wire.attempts).toEqual([{ attempt: 1, force: false, code: 'INIT_FAILED', cause: 'NoModificationAllowedError: held', elapsedMs: 12 }]);
    const back = fromWire(JSON.parse(JSON.stringify(wire)));
    expect(back.code).toBe('INIT_FAILED');
    expect((back.details as { attempts?: unknown }).attempts).toEqual(wire.attempts);
  });
});
