/**
 * Bounded boot retry for the sahpool VFS (S6-02, replaces the 10 x 300 ms loop).
 *
 * Right after a previous page's worker was killed, the browser may still hold the pool's sync access handles for a while, so
 * `installOpfsSAHPoolVfs` fails transiently ("pool could not be opened"). Two facts shape the policy:
 *
 *  1. The pinned initializer CACHES a rejected init promise per VFS name (@sqlite.org/sqlite-wasm 3.54.1-build1, dist/index.mjs ~17232-17237 and
 *     ~17294-17296): a second plain call returns the same rejection without touching OPFS again. Retries (attempt >= 2) therefore pass
 *     `forceReinitIfPreviouslyFailed: true` (declared at ~16070, honoured at ~17235). Attempt 1 never forces.
 *  2. No browser guarantees a handle-linger upper bound, so the budget is an ELAPSED time (15 s) with capped exponential backoff + jitter,
 *     not an attempt count. The client's `init` deadline must exceed it (see POOL_BOOT_BUDGET_MS use in client.ts).
 *
 * Only BUSY / INIT_FAILED-class causes are retried; quota, capacity and engine/corruption errors fail at once. Every attempt's cause and
 * elapsed time is recorded so the storage screen can show them. Nothing here ever wipes, removes the VFS or steals the writer lock: the
 * caller keeps `clearOnInit:false` + `preserveOnInitFailure:true` (a failed init releases its handles and keeps every file).
 */
import { WebStorageError } from '../web-storage/contract';
import { POOL_BOOT_BUDGET_MS, sanitizeMessage } from './protocol';
import { mapAnyError } from './worker-core';

/** Total elapsed budget for acquiring the pool. */
export { POOL_BOOT_BUDGET_MS };
export const POOL_BOOT_BACKOFF_START_MS = 250;
export const POOL_BOOT_BACKOFF_CAP_MS = 2_000;
/** +/- fraction applied to every backoff so two reloading tabs do not retry in lockstep. */
export const POOL_BOOT_JITTER = 0.25;

/** Handles still held (BUSY) or an unclassified open failure (INIT_FAILED fallback) are transient; quota, capacity and engine errors are not. */
export function isTransientPoolOpenError(error: unknown): boolean {
  const mapped = mapAnyError(error, 'INIT_FAILED');
  return mapped.code === 'BUSY' || mapped.code === 'INIT_FAILED';
}

/** One failed acquire attempt, as shown to the user / written to diagnostics (no paths, no data). */
export interface PoolBootAttempt {
  attempt: number;
  /** True when this attempt passed `forceReinitIfPreviouslyFailed` (every attempt after the first). */
  force: boolean;
  /** Mapped WebStorageErrorCode. */
  code: string;
  /** `<error name>: <sanitized message>`. */
  cause: string;
  /** Milliseconds since the first attempt started, measured when this attempt failed. */
  elapsedMs: number;
}

/** The boot retry gave up (non-transient cause, or the elapsed budget ran out). `lastError` is the LAST original error. */
export class PoolOpenFailure extends Error {
  constructor(readonly attempts: readonly PoolBootAttempt[], readonly lastError: unknown, readonly exhausted: boolean) {
    super(exhausted ? 'The storage pool could not be opened within the retry budget' : 'The storage pool could not be opened', { cause: lastError });
    this.name = 'PoolOpenFailure';
  }
}

export interface PoolOpenRetryOptions {
  budgetMs?: number;
  /** Bound for ONE `open` attempt (default 8 s, S7-03). */
  attemptTimeoutMs?: number;
  startDelayMs?: number;
  capDelayMs?: number;
  /** 0..1; default Math.random. */
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: PoolBootAttempt, nextDelayMs: number) => void;
}

export interface PoolOpenContext {
  /** 1-based. */
  attempt: number;
  /** true for every attempt after the first: pass `forceReinitIfPreviouslyFailed: true`. */
  force: boolean;
}

function describeError(error: unknown): { code: string; cause: string } {
  const e = error as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' && e.name !== '' ? e.name : 'Error';
  const message = sanitizeMessage(typeof e?.message === 'string' ? e.message : String(error));
  return { code: mapAnyError(error, 'INIT_FAILED').code, cause: `${name}: ${message}`.slice(0, 200) };
}

export function backoffDelayMs(retryIndex: number, options: Pick<PoolOpenRetryOptions, 'startDelayMs' | 'capDelayMs' | 'random'> = {}): number {
  const start = options.startDelayMs ?? POOL_BOOT_BACKOFF_START_MS;
  const cap = options.capDelayMs ?? POOL_BOOT_BACKOFF_CAP_MS;
  const base = Math.min(cap, start * 2 ** Math.max(0, retryIndex - 1));
  const jitter = 1 + (((options.random ?? Math.random)() * 2) - 1) * POOL_BOOT_JITTER;
  return Math.max(0, Math.round(Math.min(cap, base * jitter)));
}

/**
 * S7-03: ONE attempt must not be able to eat the whole budget. A never-settling `install` (a hung handle acquisition) is abandoned after
 * this long and counts as a transient INIT_FAILED, so the next attempt (forced re-init) still happens inside the elapsed budget.
 */
export const POOL_BOOT_ATTEMPT_TIMEOUT_MS = 8_000;

async function boundedAttempt<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new WebStorageError('INIT_FAILED', 'The storage pool attempt did not finish in time', { retryable: true })), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `open` until it succeeds, a non-transient error occurs, or the elapsed budget cannot cover the next backoff.
 * Throws PoolOpenFailure (attempts + last error); never wraps a success.
 */
export async function withPoolOpenRetry<T>(open: (context: PoolOpenContext) => Promise<T>, options: PoolOpenRetryOptions = {}): Promise<T> {
  const budget = options.budgetMs ?? POOL_BOOT_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const attempts: PoolBootAttempt[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const force = attempt > 1;
    try {
      return await boundedAttempt(() => open({ attempt, force }), options.attemptTimeoutMs ?? POOL_BOOT_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      const record: PoolBootAttempt = { attempt, force, ...describeError(error), elapsedMs: Math.round(now() - started) };
      attempts.push(record);
      if (!isTransientPoolOpenError(error)) throw new PoolOpenFailure(attempts, error, false);
      const delay = backoffDelayMs(attempt, options);
      if (now() - started + delay >= budget) throw new PoolOpenFailure(attempts, error, true);
      options.onRetry?.(record, delay);
      await sleep(delay);
    }
  }
}

/** The `installOpfsSAHPoolVfs` options this app uses. `forceReinitIfPreviouslyFailed` only ever appears on retries. */
export interface PoolInstallOptions {
  name: string;
  directory: string;
  initialCapacity: number;
  clearOnInit: false;
  preserveOnInitFailure: true;
  forceReinitIfPreviouslyFailed?: true;
}

/** Install (+ reserve) with the retry policy above. `install` is the pinned `sqlite3.installOpfsSAHPoolVfs`; tests spy on it. */
export function installPoolWithRetry<U extends { reserveMinimumCapacity(n: number): Promise<number> }>(
  install: (options: PoolInstallOptions) => Promise<U>,
  base: { name: string; directory: string; initialCapacity: number },
  options: PoolOpenRetryOptions = {}
): Promise<U> {
  return withPoolOpenRetry(async ({ force }) => {
    const util = await install({
      ...base,
      clearOnInit: false, // data MUST survive re-init
      preserveOnInitFailure: true, // a failed init releases handles but never deletes the pool
      ...(force ? { forceReinitIfPreviouslyFailed: true as const } : {})
    });
    await util.reserveMinimumCapacity(base.initialCapacity); // initialCapacity only applies to an empty pool
    return util;
  }, options);
}
