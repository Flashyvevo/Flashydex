/**
 * Bounded retry for opening the sahpool VFS (boot). Right after a previous page's worker was killed, the browser may still hold the pool's
 * sync access handles for a short while, so `installOpfsSAHPoolVfs` fails transiently ("pool could not be opened"). Retrying is safe only for
 * that cause: a quota/capacity/corruption failure must surface immediately (retrying cannot help and could mask real trouble).
 * The caller keeps `preserveOnInitFailure: true` / `clearOnInit: false`, so a failed attempt never deletes anything.
 */
import { mapAnyError } from './worker-core';

export const POOL_OPEN_ATTEMPTS = 10;
export const POOL_OPEN_DELAY_MS = 300;

/** Handles still held (BUSY) or an unclassified open failure (INIT_FAILED fallback) are transient; quota, capacity and engine errors are not. */
export function isTransientPoolOpenError(error: unknown): boolean {
  const mapped = mapAnyError(error, 'INIT_FAILED');
  return mapped.code === 'BUSY' || mapped.code === 'INIT_FAILED';
}

export interface PoolOpenRetryOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Runs `open` up to `attempts` times (default 10 x 300 ms); rethrows the LAST error when exhausted and the first non-transient error at once. */
export async function withPoolOpenRetry<T>(open: () => Promise<T>, options: PoolOpenRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? POOL_OPEN_ATTEMPTS);
  const delayMs = options.delayMs ?? POOL_OPEN_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await open();
    } catch (error) {
      if (attempt >= attempts || !isTransientPoolOpenError(error)) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      await sleep(delayMs);
    }
  }
}
