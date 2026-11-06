import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal exclusive Web Locks fake (ifAvailable + queued blocking requests), enough to prove single-owner release and no steal. */
function installFakeLocks() {
  let held = false;
  const queue: Array<() => void> = [];
  const grant = (name: string, callback: (lock: unknown) => Promise<unknown> | undefined, done: () => void): void => {
    held = true;
    void Promise.resolve(callback({ name })).finally(() => {
      held = false;
      done();
      queue.shift()?.();
    });
  };
  const locks = {
    request: (name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown> | undefined) =>
      new Promise<void>((resolve) => {
        if (options.ifAvailable && held) { void Promise.resolve(callback(null)).then(() => resolve()); return; }
        const run = () => grant(name, callback, resolve);
        if (held) queue.push(run); else run();
      })
  };
  vi.stubGlobal('navigator', { locks });
  return { isHeld: () => held };
}

describe('instance-lock releaseWriterLock (S6-06)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('single owner: releases a lock this page holds exactly once, a blocked taker is granted without stealing, the page never re-acquires', async () => {
    const fake = installFakeLocks();
    const lock = await import('./instance-lock');
    expect(await lock.acquireInstanceLock()).toBe('granted');
    expect(fake.isHeld()).toBe(true);
    const granted = vi.fn();
    lock.waitForInstanceLock(granted); // "tab B": blocked while A holds the lock
    await new Promise((r) => setTimeout(r, 10));
    expect(granted).not.toHaveBeenCalled(); // no steal
    expect(await lock.releaseWriterLock()).toBe(true);
    await vi.waitFor(() => expect(granted).toHaveBeenCalledTimes(1));
    expect(await lock.releaseWriterLock()).toBe(false); // already released: nothing to release twice
    expect(lock.isWriterLockReleased()).toBe(true);
    expect(await lock.acquireInstanceLock()).toBe('denied'); // the released page is never a writer again
  });

  it('is a no-op for a page that never held the lock', async () => {
    installFakeLocks();
    const lock = await import('./instance-lock');
    expect(await lock.releaseWriterLock()).toBe(false);
    expect(lock.isWriterLockReleased()).toBe(false);
  });
});
