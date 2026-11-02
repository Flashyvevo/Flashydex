import type { ImageCacheStats } from '../../web-storage/contract';

/** One ledger record per cached image (WEB-STORAGE §7 rule 2). `pending` = durable reservation written BEFORE cache.put. */
export interface LedgerEntry {
  url: string;
  bytes: number;
  lastAccess: number;
  storedAt: number;
  state: 'pending' | 'committed';
  /** Optional validator for conditional revalidation (only when the server exposes it to CORS readers). */
  etag?: string;
}

/** Cache Storage reduced to the five operations the engine needs. Keys are absolute URL strings. */
export interface CacheLike {
  has(url: string): Promise<boolean>;
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

/** Durable metadata. Every call is one atomic record write that resolves only once durable. */
export interface LedgerStore {
  loadAll(): Promise<{ entries: LedgerEntry[]; limit: number | null }>;
  putEntry(entry: LedgerEntry): Promise<void>;
  deleteEntry(url: string): Promise<void>;
  clearEntries(): Promise<void>;
  setLimit(bytes: number): Promise<void>;
}

/** Cross-event mutual exclusion (Web Lock `flashydex-image-cache` in the SW; a no-op/promise chain in tests). */
export interface LockLike {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export type AdmitReason =
  | 'stored'
  | 'oversized' // > perEntryMax or > whole limit
  | 'disabled' // admissions stopped after a quota failure
  | 'error'
  | 'quota';

export interface AdmitResult {
  stored: boolean;
  reason: AdmitReason;
  evicted: number;
}

export interface EngineLimits {
  min: number;
  default: number;
  max: number;
  perEntryMax: number;
}

export interface EngineOptions {
  cache: CacheLike;
  store: LedgerStore;
  lock: LockLike;
  limits: EngineLimits;
  now?: () => number;
  /** Debounce for lastAccess writes (ms). 0 = flush on next microtask turn. */
  touchDebounceMs?: number;
  ttlMs?: number;
}

export type { ImageCacheStats };

export const IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const IMAGE_SCHEMA_ERROR_NAME = 'QuotaExceededError';

export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
