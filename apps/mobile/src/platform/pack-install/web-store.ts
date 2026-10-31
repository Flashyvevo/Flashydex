import localforage from 'localforage';
import type { CatalogLanguageCode, CatalogReadOnlyHandle, CatalogStagingFile, PlatformCatalogStorage } from '@flashydex/core';
import { closeLogicalConnection, getSqlitePlugin, openLogicalConnection } from '../sqlite';
import type { CatalogHandle } from './catalog-handle';

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
 */
const STORE_CONFIG = { name: 'jeepSqliteStore', storeName: 'databases', driver: [localforage.INDEXEDDB] };
const MAX_WEB_BYTES = 512 * 1024 * 1024; // CATALOG-PACKS phase-1 cap per uncompressed catalog

let storeInstance: LocalForage | undefined;
function store(): LocalForage {
  storeInstance ??= localforage.createInstance(STORE_CONFIG);
  return storeInstance;
}

const storeKey = (logicalName: string) => `${logicalName}SQLite.db`;
const activeName = (language: CatalogLanguageCode) => `catalog-${language}`;
const previousName = (language: CatalogLanguageCode) => `catalog-${language}-previous`;
const candidateName = (language: CatalogLanguageCode, version: string) => `catalog-${language}-candidate-${version.replaceAll('.', '-')}`;

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

export function createWebCatalogStorage(closeActiveHandle: (language: CatalogLanguageCode) => Promise<void>): PlatformCatalogStorage {
  return {
    kind: 'web-store',
    capabilities: { atomicRename: false, readOnlyOpen: true, backupExcluded: false, streamingWrite: false },

    async availableBytes() {
      const estimate = await navigator.storage?.estimate?.();
      return estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, estimate.quota - estimate.usage) : null;
    },

    async beginStaging({ language, version, expectedBytes }) {
      return new WebStagingFile(candidateName(language, version), expectedBytes);
    },

    openReadOnly(ref): Promise<CatalogReadOnlyHandle> {
      return openHandle(ref);
    },

    async activate(language, candidateRef) {
      await closeActiveHandle(language);
      const candidate = await readBytes(candidateRef);
      if (!candidate) throw new Error('Candidate catalog is missing from the web store');
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

    async remove(language) {
      await closeActiveHandle(language);
      for (const key of await store().keys()) {
        if (key.startsWith(`catalog-${language}`)) await store().removeItem(key);
      }
    }
  };
}

/** Writable connection to the active catalog (price refresh only). The caller flushes through `flush()` after each commit. */
export async function openWritableWeb(ref: string): Promise<{ connection: SQLiteDBConnectionLike; flush(): Promise<void>; close(): Promise<void> }> {
  const connection = await openLogicalConnection(ref, false);
  return {
    connection,
    flush: async () => { await (await getSqlitePlugin()).saveToStore(ref); },
    close: () => closeLogicalConnection(ref, false)
  };
}
type SQLiteDBConnectionLike = Awaited<ReturnType<typeof openLogicalConnection>>;
