import localforage from 'localforage';
import { closeLogicalConnection, getSqlitePlugin, openLogicalConnection } from '../sqlite';
import type { CatalogHandle, CatalogLanguageCode, CatalogStagingFile, CatalogStorage, DiskState } from './storage-types';

/**
 * Web catalog storage (development / limited mode, Director D24).
 *
 * jeep-sqlite keeps each database as ONE byte array in a localforage IndexedDB store named
 * `jeepSqliteStore`/`databases`, keyed `<logicalName>SQLite.db`, and sql.js loads the whole array into memory on open
 * (docs/Web-Usage.md; jeep-sqlite 2.8.0 utils-store.js). So on web the decoded bytes are assembled into one pre-sized
 * Uint8Array (size known from the manifest, no double copy) and written to that store under a CANDIDATE name; validation
 * opens the candidate through the normal plugin path; activation copies candidate -> active key and keeps the old
 * active as `previous`. This is NOT atomic across keys (`capabilities.atomicRename = false`) and the whole DB lives in
 * memory (`streamingWrite = false`). Production catalogs belong on native.
 *
 * `inspect` (R06) reads the store KEYS, never memory: boot recovery sees exactly what survived a crash. Activation order
 * (previous written first, then active, then the candidate key removed) means every crash point leaves a state that
 * `inspect` + core's journal can reconcile: a leftover candidate, or previous == active bytes.
 */
const STORE_CONFIG = { name: 'jeepSqliteStore', storeName: 'databases', driver: [localforage.INDEXEDDB] };
const MAX_WEB_BYTES = 512 * 1024 * 1024; // CATALOG-PACKS phase-1 cap per uncompressed catalog

let storeInstance: LocalForage | undefined;
function store(): LocalForage {
  storeInstance ??= localforage.createInstance(STORE_CONFIG);
  return storeInstance;
}

const SUFFIX = 'SQLite.db';
const storeKey = (logicalName: string) => `${logicalName}${SUFFIX}`;
const activeName = (language: CatalogLanguageCode) => `catalog-${language}`;
const previousName = (language: CatalogLanguageCode) => `catalog-${language}-previous`;
const candidatePrefix = (language: CatalogLanguageCode) => `catalog-${language}-candidate-`;
const candidateName = (language: CatalogLanguageCode, version: string) => `${candidatePrefix(language)}${version.replaceAll('.', '-')}`;

async function readBytes(logicalName: string): Promise<Uint8Array | null> {
  const value = await store().getItem<Uint8Array>(storeKey(logicalName));
  return value instanceof Uint8Array && value.length > 0 ? value : null;
}

class WebStagingFile implements CatalogStagingFile {
  readonly chunkEncoding = 'bytes' as const;
  private readonly buffer: Uint8Array;
  private offset = 0;
  constructor(readonly ref: string, expectedBytes: number) {
    if (expectedBytes > MAX_WEB_BYTES) throw new Error(`Catalog of ${expectedBytes} bytes exceeds the web limit of ${MAX_WEB_BYTES}`);
    this.buffer = new Uint8Array(expectedBytes);
  }
  async append(chunk: Uint8Array | string): Promise<void> {
    if (typeof chunk === 'string') throw new Error('web staging expects raw bytes');
    if (this.offset + chunk.length > this.buffer.length) throw new Error('Decoded output is larger than the manifest size');
    this.buffer.set(chunk, this.offset);
    this.offset += chunk.length;
  }
  async finish(): Promise<{ bytes: number }> {
    const bytes = this.offset === this.buffer.length ? this.buffer : this.buffer.slice(0, this.offset);
    await store().setItem(storeKey(this.ref), bytes);
    return { bytes: this.offset };
  }
  async abort(): Promise<void> {
    await store().removeItem(storeKey(this.ref)).catch(() => undefined);
  }
}

async function openHandle(ref: string): Promise<CatalogHandle> {
  const connection = await openLogicalConnection(ref, true);
  return {
    connection,
    query: (statement, values) => connection.query(statement, values as never[]) as Promise<{ values?: unknown[] }>,
    close: () => closeLogicalConnection(ref, true)
  };
}

const isCandidateRef = (ref: string) => /^catalog-(en|ja)-candidate-/.test(ref);

export function createWebCatalogStorage(closeActiveHandle: (language: CatalogLanguageCode) => Promise<void>): CatalogStorage {
  return {
    kind: 'web-store',
    capabilities: { atomicRename: false, readOnlyOpen: true, backupExcluded: false, streamingWrite: false },

    async availableBytes() {
      const estimate = await navigator.storage?.estimate?.();
      return estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, estimate.quota - estimate.usage) : null;
    },

    async beginStaging({ language, version, expectedBytes }) {
      for (const key of await store().keys()) {
        if (key.startsWith(candidatePrefix(language)) && key.endsWith(SUFFIX)) await store().removeItem(key);
      }
      return new WebStagingFile(candidateName(language, version), expectedBytes);
    },

    openReadOnly(ref) {
      return openHandle(ref);
    },

    async activate(language, candidateRef) {
      if (!isCandidateRef(candidateRef)) throw new Error('Not a staged candidate');
      const candidate = await readBytes(candidateRef);
      if (!candidate) throw new Error('Candidate catalog is missing from the web store');
      await closeActiveHandle(language);
      const current = await readBytes(activeName(language));
      let previousRef: string | null = null;
      if (current) {
        await store().setItem(storeKey(previousName(language)), current);
        previousRef = previousName(language);
      }
      await store().setItem(storeKey(activeName(language)), candidate);
      await store().removeItem(storeKey(candidateRef));
      return { activeRef: activeName(language), previousRef };
    },

    async discardPrevious(language) {
      await store().removeItem(storeKey(previousName(language)));
    },

    async discardCandidate(ref) {
      if (!isCandidateRef(ref)) throw new Error('Refusing to discard a non-candidate ref');
      await store().removeItem(storeKey(ref));
    },

    async restorePrevious(language) {
      const previous = await readBytes(previousName(language));
      if (!previous) return false;
      await closeActiveHandle(language);
      await store().setItem(storeKey(activeName(language)), previous);
      await store().removeItem(storeKey(previousName(language)));
      return true;
    },

    async activeRef(language) {
      return (await readBytes(activeName(language))) ? activeName(language) : null;
    },

    async inspect(language): Promise<DiskState> {
      const keys = await store().keys();
      const has = (name: string) => keys.includes(storeKey(name));
      return {
        activeRef: has(activeName(language)) ? activeName(language) : null,
        previousRef: has(previousName(language)) ? previousName(language) : null,
        candidateRefs: keys.filter((key) => key.startsWith(candidatePrefix(language)) && key.endsWith(SUFFIX)).map((key) => key.slice(0, -SUFFIX.length))
      };
    },

    async remove(language) {
      await closeActiveHandle(language);
      for (const key of await store().keys()) {
        if (key.startsWith(`catalog-${language}`)) await store().removeItem(key);
      }
    }
  };
}

/** Writable connection to the active catalog (price refresh etc.). The caller flushes through `flush()` after each commit. */
export async function openWritableWeb(ref: string): Promise<{ connection: SQLiteDBConnectionLike; flush(): Promise<void>; close(): Promise<void> }> {
  const connection = await openLogicalConnection(ref, false);
  return {
    connection,
    flush: async () => { await (await getSqlitePlugin()).saveToStore(ref); },
    close: () => closeLogicalConnection(ref, false)
  };
}
type SQLiteDBConnectionLike = Awaited<ReturnType<typeof openLogicalConnection>>;
