import { errorCode } from './errors';

/**
 * Query retry policy (Stage E / E2): a read that raced a catalog activation (`STALE_READ`) or a restore/activation barrier
 * (`MAINTENANCE`) is refetched once, silently, after a short pause; a second failure shows the normal error copy.
 * Every other error is never retried (offline, storage and validation errors are deterministic or user-visible).
 * Mutations never use this: they are `retry: false` and a `MAINTENANCE` refusal is shown, not repeated.
 */
export function retryTransientRead(failureCount: number, error: unknown): boolean {
  const code = errorCode(error);
  return failureCount < 1 && (code === 'STALE_READ' || code === 'MAINTENANCE');
}

export const TRANSIENT_READ_RETRY_DELAY_MS = 350;
