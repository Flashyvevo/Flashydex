import { IMAGE_TTL_MS, isQuotaError } from './types';
import type { AdmitResult, EngineOptions, ImageCacheStats, LedgerEntry } from './types';

export interface AdmitInput {
  url: string;
  body: Uint8Array;
  contentType: string;
  etag?: string | undefined;
}

export interface LookupResult {
  response: Response;
  stale: boolean;
  etag?: string | undefined;
}

export interface ImageEngine {
  admit(input: AdmitInput): Promise<AdmitResult>;
  /** Cache hit (committed entries only). Updates recency in memory immediately; the durable write is debounced. */
  lookup(url: string): Promise<LookupResult | null>;
  /** Recency touch. The returned promise settles after the debounced durable write (hold it with event.waitUntil). */
  touch(url: string): Promise<void>;
  /** A conditional revalidation said "not modified": restart the TTL clock without touching bytes. */
  markFresh(url: string): Promise<void>;
  stats(): Promise<ImageCacheStats>;
  clear(): Promise<ImageCacheStats>;
  setLimit(bytes: number): Promise<ImageCacheStats>;
  reconcile(): Promise<void>;
}

/**
 * The byte-bounded LRU ledger (WEB-STORAGE §7). Pure: Cache Storage, IndexedDB and the Web Lock are injected.
 * Invariant held at every durable write: committed + reserved (+ the entry being reserved) <= limit.
 * Cache Storage and IDB cannot commit atomically, so the order is reserve(IDB) -> put(Cache) -> commit(IDB), and every restart or
 * error runs reconcile(), which deletes pending/untracked cache entries and drops ledger rows that have no cache entry.
 */
export function createImageEngine(options: EngineOptions): ImageEngine {
  const { cache, store, lock, limits } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? IMAGE_TTL_MS;
  const touchDebounceMs = options.touchDebounceMs ?? 1500;

  const entries = new Map<string, LedgerEntry>();
  let loaded = false;
  let limit = limits.default;
  let paused = false;
  let lastError: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  const dirtyTouches = new Set<string>();
  let flushPromise: Promise<void> | null = null;

  const clamp = (bytes: number) => Math.min(limits.max, Math.max(limits.min, Math.floor(Number.isFinite(bytes) ? bytes : limits.default)));

  /** SW-local queue on top of the cross-context lock: two events in one worker never interleave either. */
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const p = tail.then(() => lock.run(fn));
    tail = p.catch(() => undefined);
    return p;
  }

  const totals = () => {
    let committed = 0;
    let reserved = 0;
    for (const e of entries.values()) {
      if (e.state === 'committed') committed += e.bytes;
      else reserved += e.bytes;
    }
    return { committed, reserved };
  };

  const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

  async function removeEntry(url: string): Promise<void> {
    // Cache first, then ledger: a crash in between leaves an over-counted row, which reconcile drops. Never an uncharged byte.
    await cache.delete(url);
    await store.deleteEntry(url);
    entries.delete(url);
  }

  async function evictToCap(extra: number): Promise<number> {
    let evicted = 0;
    for (;;) {
      const { committed, reserved } = totals();
      if (committed + reserved + extra <= limit) return evicted;
      let oldest: LedgerEntry | null = null;
      for (const e of entries.values()) {
        if (e.state !== 'committed') continue;
        if (!oldest || e.lastAccess < oldest.lastAccess || (e.lastAccess === oldest.lastAccess && e.storedAt < oldest.storedAt)) oldest = e;
      }
      if (!oldest) return evicted;
      await removeEntry(oldest.url);
      evicted += 1;
    }
  }

  async function reconcileInner(): Promise<void> {
    loaded = false;
    const snapshot = await store.loadAll();
    limit = clamp(snapshot.limit ?? limits.default);
    const keys = new Set(await cache.keys());
    entries.clear();
    for (const row of snapshot.entries) {
      if (row.state === 'pending') {
        // An abandoned reservation: its bytes are not trusted and not retained.
        if (keys.has(row.url)) {
          await cache.delete(row.url);
          keys.delete(row.url);
        }
        await store.deleteEntry(row.url);
        continue;
      }
      if (!keys.has(row.url)) {
        await store.deleteEntry(row.url); // metadata without bytes
        continue;
      }
      keys.delete(row.url);
      entries.set(row.url, row);
    }
    for (const orphan of keys) await cache.delete(orphan); // bytes without metadata
    await evictToCap(0);
    loaded = true;
  }

  async function ensureReady(): Promise<void> {
    if (!loaded) await reconcileInner();
  }

  async function softReconcile(): Promise<void> {
    try {
      await reconcileInner();
    } catch (error) {
      loaded = false;
      lastError = describe(error);
    }
  }

  async function storeOnce(input: AdmitInput, size: number, isRetry: boolean): Promise<AdmitResult> {
    let evicted = 0;
    try {
      if (entries.has(input.url)) await removeEntry(input.url); // replacement: old charge leaves only after the old entry is gone
      evicted = await evictToCap(size);
      const stamp = now();
      const pending: LedgerEntry = { url: input.url, bytes: size, lastAccess: stamp, storedAt: stamp, state: 'pending' };
      if (input.etag) pending.etag = input.etag;
      await store.putEntry(pending); // durable reservation BEFORE the bytes exist
      entries.set(input.url, pending);
      try {
        const response = new Response(input.body as BodyInit, {
          status: 200,
          headers: { 'content-type': input.contentType, 'x-fdx-stored-at': String(stamp) }
        });
        await cache.put(input.url, response);
      } catch (error) {
        await cache.delete(input.url).catch(() => undefined);
        await store.deleteEntry(input.url).catch(() => undefined);
        entries.delete(input.url);
        throw error;
      }
      const committed: LedgerEntry = { ...pending, state: 'committed' };
      await store.putEntry(committed);
      entries.set(input.url, committed);
      return { stored: true, reason: 'stored', evicted };
    } catch (error) {
      if (isQuotaError(error)) {
        await softReconcile();
        if (!isRetry && loaded) return storeOnce(input, size, true);
        paused = true;
        lastError = 'Image cache stopped: storage quota exceeded';
        return { stored: false, reason: 'quota', evicted };
      }
      lastError = describe(error);
      await softReconcile();
      return { stored: false, reason: 'error', evicted };
    }
  }

  async function flushTouches(): Promise<void> {
    await run(async () => {
      const urls = [...dirtyTouches];
      dirtyTouches.clear();
      for (const url of urls) {
        const entry = entries.get(url);
        if (!entry || entry.state !== 'committed') continue;
        await store.putEntry({ ...entry }).catch(() => undefined); // a lost touch never invalidates totals
      }
    }).catch(() => undefined);
  }

  function touch(url: string): Promise<void> {
    const entry = entries.get(url);
    if (!entry || entry.state !== 'committed') return Promise.resolve();
    entry.lastAccess = now();
    dirtyTouches.add(url);
    flushPromise ??= new Promise<void>((resolve) => {
      setTimeout(() => {
        flushPromise = null;
        void flushTouches().then(resolve, resolve);
      }, touchDebounceMs);
    });
    return flushPromise;
  }

  function statsNow(): ImageCacheStats {
    const { committed, reserved } = totals();
    return {
      enforced: loaded,
      limitBytes: limit,
      committedBytes: committed,
      reservedBytes: reserved,
      entries: entries.size,
      lastError: paused && !lastError ? 'Image cache stopped' : lastError,
      reason: loaded ? null : 'ledger_unavailable'
    };
  }

  return {
    admit(input) {
      return run(async () => {
        try {
          await ensureReady();
        } catch (error) {
          lastError = describe(error);
          return { stored: false, reason: 'error', evicted: 0 } as AdmitResult;
        }
        if (paused) return { stored: false, reason: 'disabled', evicted: 0 } as AdmitResult;
        const size = input.body.byteLength;
        if (size > limits.perEntryMax || size > limit) return { stored: false, reason: 'oversized', evicted: 0 } as AdmitResult;
        return storeOnce(input, size, false);
      });
    },

    lookup(url) {
      return run(async () => {
        try {
          await ensureReady();
        } catch (error) {
          lastError = describe(error);
          return null;
        }
        const entry = entries.get(url);
        if (!entry || entry.state !== 'committed') return null;
        const response = await cache.match(url).catch(() => undefined);
        if (!response) {
          await removeEntry(url).catch(() => undefined);
          return null;
        }
        void touch(url);
        return { response, stale: now() - entry.storedAt > ttlMs, etag: entry.etag };
      });
    },

    touch,

    markFresh(url) {
      return run(async () => {
        const entry = entries.get(url);
        if (!entry || entry.state !== 'committed') return;
        entry.storedAt = now();
        await store.putEntry({ ...entry }).catch(() => undefined);
      });
    },

    stats() {
      return run(async () => {
        try {
          await ensureReady();
        } catch (error) {
          lastError = describe(error);
        }
        return statsNow();
      });
    },

    clear() {
      return run(async () => {
        try {
          for (const url of await cache.keys()) await cache.delete(url);
          await store.clearEntries();
          entries.clear();
          dirtyTouches.clear();
          paused = false;
          lastError = null;
          loaded = true;
        } catch (error) {
          lastError = describe(error);
          await softReconcile();
        }
        return statsNow();
      });
    },

    setLimit(bytes) {
      return run(async () => {
        try {
          await ensureReady();
          limit = clamp(bytes);
          await store.setLimit(limit);
          paused = false;
          await evictToCap(0); // evicts before the ACK is sent
        } catch (error) {
          lastError = describe(error);
          await softReconcile();
        }
        return statsNow();
      });
    },

    reconcile() {
      return run(softReconcile);
    }
  };
}
