import type { CacheLike, LedgerEntry, LedgerStore, LockLike } from './types';
import { IMAGE_CACHE_LOCK } from '../../web-storage/contract';

/** Real IndexedDB ledger. Every write resolves on the transaction's `complete` event (durable), never on request success. */
export const IMAGE_LEDGER_DB = 'flashydex-image-ledger-v1';
const ENTRIES = 'entries';
const META = 'meta';
const LIMIT_KEY = 'limit';

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'url' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export function createIdbLedger(dbName: string = IMAGE_LEDGER_DB): LedgerStore & { close(): Promise<void> } {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    dbPromise ??= openDb(dbName).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const database = await db();
    return new Promise<T | undefined>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(stores, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      } catch (error) {
        dbPromise = null; // connection closed underneath us (e.g. browser upgrade): reopen next time
        reject(error);
        return;
      }
      let result: T | undefined;
      const request = fn(transaction);
      if (request) request.onsuccess = () => (result = request.result);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  }

  return {
    async loadAll() {
      const entries = ((await tx<LedgerEntry[]>([ENTRIES], 'readonly', (t) => t.objectStore(ENTRIES).getAll())) ?? []) as LedgerEntry[];
      const limit = await tx<unknown>([META], 'readonly', (t) => t.objectStore(META).get(LIMIT_KEY));
      return { entries: entries.filter(isLedgerEntry), limit: typeof limit === 'number' ? limit : null };
    },
    async putEntry(entry) {
      await tx([ENTRIES], 'readwrite', (t) => t.objectStore(ENTRIES).put(entry));
    },
    async deleteEntry(url) {
      await tx([ENTRIES], 'readwrite', (t) => t.objectStore(ENTRIES).delete(url));
    },
    async clearEntries() {
      await tx([ENTRIES], 'readwrite', (t) => t.objectStore(ENTRIES).clear());
    },
    async setLimit(bytes) {
      await tx([META], 'readwrite', (t) => t.objectStore(META).put(bytes, LIMIT_KEY));
    },
    async close() {
      if (!dbPromise) return;
      (await dbPromise).close();
      dbPromise = null;
    }
  };
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.url === 'string' && typeof e.bytes === 'number' && e.bytes >= 0 && (e.state === 'pending' || e.state === 'committed') && typeof e.lastAccess === 'number' && typeof e.storedAt === 'number';
}

/** Cache Storage -> CacheLike. Keys are absolute URL strings. */
export function createCacheStorageAdapter(cacheName: string, storage: CacheStorage = caches): CacheLike {
  const open = () => storage.open(cacheName);
  return {
    async has(url) {
      return (await (await open()).match(url)) !== undefined;
    },
    async match(url) {
      return (await open()).match(url);
    },
    async put(url, response) {
      await (await open()).put(url, response);
    },
    async delete(url) {
      return (await open()).delete(url);
    },
    async keys() {
      return (await (await open()).keys()).map((r) => r.url);
    }
  };
}

/** Cross-context lock `flashydex-image-cache`; degrades to a pass-through where Web Locks are missing (the engine still has its local queue). */
export function createWebLock(name: string = IMAGE_CACHE_LOCK): LockLike {
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      if (!locks) return fn();
      return locks.request(name, fn) as Promise<T>;
    }
  };
}
