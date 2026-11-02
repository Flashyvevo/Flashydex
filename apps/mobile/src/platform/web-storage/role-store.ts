import {
  ROLE_DB_NAME, WebStorageError,
  type CatalogCandidate, type ImportIntent, type LanguageRoles, type MigrationMarker, type PoolPath, type RoleStateV1, type RoleStore, type UserRole, type WebLanguage
} from './contract';
import * as roles from './role-state';

/**
 * Role store (contract `RoleStore`) over raw IndexedDB `flashydex-web-storage-v1`.
 *
 * Schema v1: one object store `meta` with ONE record `state` (the whole `RoleStateV1`). A single record makes every mutation one
 * readwrite transaction by construction: get -> pure transition (role-state.ts) -> put, resolved only on the transaction's `complete`
 * event (strict durability hint where the browser supports it). Reads always go to IndexedDB: nothing is cached in JS except the open
 * connection. A record that fails validation, an unknown schema or a database from a newer version -> METADATA_CORRUPT; nothing is ever
 * reset, deleted or "repaired" here.
 */
const STORE = 'meta';
const KEY = 'state';
const DB_VERSION = 1;

/** One atomic read-modify-write over the persisted state record. `raw` is `undefined` before the first write. */
export interface StateCell {
  read(): Promise<unknown>;
  /** `fn` runs synchronously inside the transaction; returning `next: null` writes nothing; throwing aborts with no change. */
  mutate<T>(fn: (raw: unknown) => { next: unknown; result: T }): Promise<T>;
}

export function createRoleStoreFromCell(cell: StateCell): RoleStore {
  const current = async (): Promise<RoleStateV1> => {
    const raw = await cell.read();
    return raw === undefined ? roles.emptyRoleState() : roles.parseRoleState(raw);
  };
  const transact = <T>(transition: (state: RoleStateV1) => roles.Transition<T>): Promise<T> =>
    cell.mutate((raw) => {
      const state = raw === undefined ? roles.emptyRoleState() : roles.parseRoleState(raw);
      const { state: next, result } = transition(state);
      return { next, result };
    });
  return {
    load: current,
    async language(language: WebLanguage): Promise<LanguageRoles> {
      return (await current()).languages[language];
    },
    addCandidate: (language, candidate: CatalogCandidate) => transact((state) => roles.addCandidate(state, language, candidate)),
    removeCandidate: (language, ref: PoolPath) => transact((state) => roles.removeCandidate(state, language, ref)),
    activate: (language, candidateRef, expectedActiveRef) => transact((state) => roles.activate(state, language, candidateRef, expectedActiveRef)),
    restorePrevious: (language, expectedActiveRef) => transact((state) => roles.restorePrevious(state, language, expectedActiveRef)),
    clearPrevious: (language) => transact((state) => roles.clearPrevious(state, language)),
    clearLanguage: (language) => transact((state) => roles.clearLanguage(state, language)),
    async user(): Promise<UserRole | null> {
      return (await current()).user;
    },
    async migration(): Promise<MigrationMarker | null> {
      return (await current()).migration;
    },
    commitUser: (role, marker, options) => transact((state) => roles.commitUser(state, role, marker, options)),
    putIntent: (intent: ImportIntent) => transact((state) => roles.putIntent(state, intent)),
    clearIntent: (job) => transact((state) => roles.clearIntent(state, job)),
    async listIntents(): Promise<ImportIntent[]> {
      return (await current()).intents;
    }
  };
}

/** In-memory cell for unit tests: structured-clone isolation, atomic (a throwing `fn` leaves the value untouched). */
export function createMemoryStateCell(initial?: unknown): StateCell & { raw(): unknown } {
  let value: unknown = initial === undefined ? undefined : structuredClone(initial);
  return {
    raw: () => (value === undefined ? undefined : structuredClone(value)),
    read: async () => (value === undefined ? undefined : structuredClone(value)),
    async mutate(fn) {
      const { next, result } = fn(value === undefined ? undefined : structuredClone(value));
      if (next !== null) value = structuredClone(next);
      return result;
    }
  };
}

// ───────────────────────────────────────────── IndexedDB cell ─────────────────────────────────────────────

const corruptDb = (why: string, cause?: unknown): WebStorageError => new WebStorageError('METADATA_CORRUPT', `Role metadata store is unusable: ${why}`, { cause });

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new WebStorageError('STORAGE_UNAVAILABLE', 'IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = (event) => {
      // Only version 0 -> 1 exists. A future schema never reaches this handler on old code (VersionError below).
      if (event.oldVersion < 1) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        reject(corruptDb('missing object store'));
        return;
      }
      resolve(db);
    };
    request.onerror = () => {
      const error = request.error;
      reject(error?.name === 'VersionError' ? corruptDb('database was written by a newer version', error) : corruptDb(error?.message ?? 'open failed', error));
    };
    request.onblocked = () => reject(new WebStorageError('BUSY', 'The role store is blocked by another connection'));
  });
}

export function createIdbStateCell(name: string): StateCell {
  let connection: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    connection ??= openDatabase(name).then((opened) => {
      opened.onversionchange = () => { opened.close(); connection = null; };
      opened.onclose = () => { connection = null; };
      return opened;
    });
    connection.catch(() => { connection = null; });
    return connection;
  };
  const begin = (database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction => {
    if (mode === 'readwrite') {
      try {
        return database.transaction(STORE, mode, { durability: 'strict' });
      } catch {
        /* options unsupported */
      }
    }
    return database.transaction(STORE, mode);
  };
  return {
    async read() {
      const database = await db();
      return new Promise<unknown>((resolve, reject) => {
        const tx = begin(database, 'readonly');
        const request = tx.objectStore(STORE).get(KEY);
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(corruptDb(tx.error?.message ?? 'read failed', tx.error));
        tx.onabort = () => reject(corruptDb(tx.error?.message ?? 'read aborted', tx.error));
      });
    },
    async mutate<T>(fn: (raw: unknown) => { next: unknown; result: T }): Promise<T> {
      const database = await db();
      return new Promise<T>((resolve, reject) => {
        const tx = begin(database, 'readwrite');
        const store = tx.objectStore(STORE);
        let outcome: { result: T } | null = null;
        let failure: unknown;
        const request = store.get(KEY);
        request.onsuccess = () => {
          try {
            const { next, result } = fn(request.result);
            outcome = { result };
            if (next !== null) store.put(next, KEY);
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        tx.oncomplete = () => (outcome ? resolve(outcome.result) : reject(corruptDb('transaction completed without a result')));
        tx.onabort = () => reject(failure ?? new WebStorageError('IO', 'The role transaction was aborted', { commitState: 'rolled_back', cause: tx.error ?? undefined }));
        tx.onerror = () => { failure ??= tx.error ?? undefined; };
      });
    }
  };
}

export function createRoleStore(dbName: string = ROLE_DB_NAME): RoleStore {
  return createRoleStoreFromCell(createIdbStateCell(dbName));
}

let singleton: RoleStore | undefined;
export function getRoleStore(): RoleStore {
  singleton ??= createRoleStore();
  return singleton;
}
