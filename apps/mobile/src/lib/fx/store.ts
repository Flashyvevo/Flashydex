import { isValidFxRecord, type FxProvider, type FxRecord } from '@flashydex/core';

/** App-storage cache of the last verified EUR→USD record. NOT the user database. */
export const FX_STORAGE_KEY = 'fdx.fx.EURUSD';
export const FX_STORE_VERSION = 1;

type Stored = { v: typeof FX_STORE_VERSION; record: FxRecord };

/** Read and validate the persisted record. Unknown version / corrupt JSON / invalid record → null (never a default rate). */
export function readStoredFx(storage: Pick<Storage, 'getItem'> | null = safeStorage()): FxRecord | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(FX_STORAGE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<Stored> | null;
    if (!parsed || parsed.v !== FX_STORE_VERSION) return null;
    const record = parsed.record as FxRecord | undefined;
    return isValidFxRecord(record) && typeof record.fetchedAt === 'string' && record.provider === 'frankfurter' ? record : null;
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
  private readonly listeners = new Set<() => void>();
  constructor(private readonly storage: Storage | null = safeStorage()) {
    this.record = readStoredFx(storage);
  }
  get(base: 'EUR', quote: 'USD'): FxRecord | null {
    return base === 'EUR' && quote === 'USD' ? this.record : null;
  }
  snapshot = (): FxRecord | null => this.record;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Adopt a fresh record only when it is not older than the one we hold. Returns true when the snapshot changed. */
  set(record: FxRecord): boolean {
    if (!isValidFxRecord(record)) return false;
    const current = this.record;
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
const MIN_REFETCH_MS = 6 * 3_600_000;

/** Refresh when no record, or the rate date is older than 1 day — but never more often than every 6 h (ECB publishes weekdays only). */
export function fxNeedsRefresh(record: FxRecord | null, nowIso: string): boolean {
  if (!record) return true;
  const now = Date.parse(nowIso);
  const rateMs = Date.parse(`${record.rateDate}T00:00:00.000Z`);
  if (!Number.isFinite(now) || !Number.isFinite(rateMs)) return true;
  if (now - rateMs <= DAY_MS) return false;
  const fetched = Date.parse(record.fetchedAt);
  return !Number.isFinite(fetched) || now - fetched >= MIN_REFETCH_MS;
}
