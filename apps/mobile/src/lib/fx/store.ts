import { validateFxRecord, type FxProvider, type FxRecord } from '@flashydex/core';

/** App-storage cache of the last verified EUR→USD record. NOT the user database. */
export const FX_STORAGE_KEY = 'fdx.fx.EURUSD';
/** Separate key: the last refresh ATTEMPT (success or failure), so failures are throttled too. */
export const FX_ATTEMPT_KEY = 'fdx.fx.EURUSD.attempt';
export const FX_STORE_VERSION = 1;

type Stored = { v: typeof FX_STORE_VERSION; record: FxRecord };
type ReadStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'removeItem'>>;

function drop(storage: ReadStorage, key: string): void {
  try {
    storage.removeItem?.(key);
  } catch {
    /* storage unavailable: the record is still ignored in memory */
  }
}

/**
 * Read and strictly validate the persisted record against the clock. Unknown version → null (left alone: a newer app may own it).
 * Corrupt JSON / invalid or future-dated record → null AND the key is deleted so a valid fetch can replace it (never a default rate).
 */
export function readStoredFx(storage: ReadStorage | null = safeStorage(), nowIso: string = new Date().toISOString()): FxRecord | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(FX_STORAGE_KEY);
    if (!text) return null;
    let parsed: Partial<Stored> | null;
    try {
      parsed = JSON.parse(text) as Partial<Stored> | null;
    } catch {
      drop(storage, FX_STORAGE_KEY);
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      drop(storage, FX_STORAGE_KEY);
      return null;
    }
    if (parsed.v !== FX_STORE_VERSION) return null;
    const record = validateFxRecord(parsed.record, nowIso);
    if (!record) drop(storage, FX_STORAGE_KEY);
    return record;
  } catch {
    return null;
  }
}

export function writeStoredFx(record: FxRecord, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FX_STORAGE_KEY, JSON.stringify({ v: FX_STORE_VERSION, record } satisfies Stored));
    return true;
  } catch {
    return false;
  }
}

/** Last attempt instant, or null when absent/garbage/in the future (a future stamp would block refreshes forever; it is deleted). */
export function readLastAttempt(storage: ReadStorage | null = safeStorage(), nowIso: string = new Date().toISOString()): string | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(FX_ATTEMPT_KEY);
    if (!text) return null;
    const ms = Date.parse(text);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(ms) || !Number.isFinite(now) || ms > now + 60_000) {
      drop(storage, FX_ATTEMPT_KEY);
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

export function writeLastAttempt(nowIso: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FX_ATTEMPT_KEY, nowIso);
    return true;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** In-memory snapshot over the persisted record; the sync `FxProvider` handed to core. */
export class FxStore implements FxProvider {
  private record: FxRecord | null;
  private attemptAt: string | null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: Storage | null = safeStorage(), nowIso: string = new Date().toISOString()) {
    this.record = readStoredFx(storage, nowIso);
    this.attemptAt = readLastAttempt(storage, nowIso);
  }
  get(base: 'EUR', quote: 'USD'): FxRecord | null {
    return base === 'EUR' && quote === 'USD' ? this.record : null;
  }
  snapshot = (): FxRecord | null => this.record;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Instant of the last refresh attempt (any outcome), or null. */
  lastAttemptAt(): string | null {
    return this.attemptAt;
  }
  /** Record that a refresh attempt started now (persisted under its own key; in-memory even when storage is unavailable). */
  markAttempt(nowIso: string): void {
    this.attemptAt = nowIso;
    writeLastAttempt(nowIso, this.storage);
  }
  /**
   * Adopt a fresh VALID record when it is not older than the one we hold. A held record that is itself invalid now
   * (e.g. dated in the future) never blocks a valid one: it is replaced. Returns true when the snapshot changed.
   */
  set(record: FxRecord, nowIso: string = new Date().toISOString()): boolean {
    if (!validateFxRecord(record, nowIso)) return false;
    const current = this.record && validateFxRecord(this.record, nowIso) ? this.record : null;
    if (current && record.rateDate < current.rateDate) return false;
    if (current && current.rate === record.rate && current.rateDate === record.rateDate) {
      // Same reference rate: remember the newer fetch time (throttles refresh) without re-rendering consumers.
      this.record = record;
      if (this.storage) writeStoredFx(record, this.storage);
      return false;
    }
    this.record = record;
    if (this.storage) writeStoredFx(record, this.storage);
    this.listeners.forEach((l) => l());
    return true;
  }
}

export const fxStore = new FxStore();

const DAY_MS = 86_400_000;
export const MIN_ATTEMPT_GAP_MS = 6 * 3_600_000;

/**
 * Refresh when no record, or the rate date is older than 1 day — but never more often than every 6 h between ATTEMPTS
 * (success or failure; ECB publishes weekdays only and Frankfurter has no SLA). `lastAttemptAt` is the persisted attempt stamp.
 */
export function fxNeedsRefresh(record: FxRecord | null, nowIso: string, lastAttemptAt: string | null = null): boolean {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return false;
  if (lastAttemptAt) {
    const attempted = Date.parse(lastAttemptAt);
    if (Number.isFinite(attempted) && now - attempted < MIN_ATTEMPT_GAP_MS && attempted <= now) return false;
  }
  if (!record) return true;
  const rateMs = Date.parse(`${record.rateDate}T00:00:00.000Z`);
  if (!Number.isFinite(rateMs)) return true;
  if (now - rateMs <= DAY_MS) return false;
  const fetched = Date.parse(record.fetchedAt);
  return !Number.isFinite(fetched) || now - fetched >= MIN_ATTEMPT_GAP_MS;
}
