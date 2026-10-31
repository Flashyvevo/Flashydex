import type { CatalogInstallPort, CatalogSource, PackDiskState, PackEntry, PackStageResult, SqlDriver } from '@flashydex/core';
import { Capacitor } from '@capacitor/core';
import { closeLogicalConnection, flushWebStore, openLogicalConnection, USER_DB_NAME } from './sqlite';
import { createProxyCallback } from './sqlite-proxy';
import {
  closeCatalogDb, fetchManifestText, getCatalogStorage, openCatalogDb, openCatalogDbWritable, openCatalogRef, removeCatalog, stageCatalogPack,
  type CatalogLanguageCode
} from './pack-install';
import { NATIVE_CATALOG_WRITES } from './pack-install/native-store';

/**
 * The user DB as a core `SqlDriver`: one connection, sqlite-proxy callback, web store flushed after every committed transaction.
 *
 * `reopen` is deliberately NOT implemented (R02). jeep-sqlite 2.8.0 `closeConnection` -> `Database.close()` runs
 * `saveToStore()` first (node_modules/jeep-sqlite/dist/collection/utils/database.js:110-126), i.e. it would WRITE the in-memory snapshot
 * (the very state whose flush just failed) back to IndexedDB before closing, and the plugin offers no discard-without-save. So on web
 * `services.storage.recover()` rejects and the UI offers a real `location.reload()`, which re-reads the persisted bytes. On native the
 * flush is a no-op (SQLite commits are already durable), so a persistence latch cannot occur there.
 */
export async function createUserDriver(): Promise<SqlDriver> {
  const connection = await openLogicalConnection(USER_DB_NAME);
  const web = Capacitor.getPlatform() === 'web';
  const proxy = createProxyCallback(connection);
  return {
    label: USER_DB_NAME,
    // DEV-ONLY e2e seam (`window.__flashydexTest.sqlDelayMs`): makes a restore long enough to observe. Compiled out of production builds.
    proxy: import.meta.env.DEV
      ? async (sql, params, method) => {
          const delay = (window as unknown as { __flashydexTest?: { sqlDelayMs?: number } }).__flashydexTest?.sqlDelayMs;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          return proxy(sql, params, method);
        }
      : proxy,
    afterCommit: web ? () => flushWebStore(USER_DB_NAME) : undefined,
    close: () => closeLogicalConnection(USER_DB_NAME)
  };
}

const isWeb = () => Capacitor.getPlatform() === 'web';
/** Web keeps catalog writes (in-memory sql.js + IndexedDB put). Native is OFF until the writable-copy design is proven on a Mac (R04). */
const catalogWrites = (): boolean => (isWeb() ? true : NATIVE_CATALOG_WRITES); // TODO(R04-mac): native catalogWrites switch

/** Catalog connections are read-only handles owned by the pack installer; an absent catalog is `null`, never created. */
export const catalogSource: CatalogSource = {
  get writable() {
    return catalogWrites();
  },
  async open(language) {
    if ((await getCatalogStorage().activeRef(language)) === null) return null;
    const connection = await openCatalogDb(language);
    return {
      label: `catalog-${language}`,
      proxy: createProxyCallback(connection),
      close: () => closeCatalogDb(language)
    };
  },
  async openWritable(language) {
    if (!catalogWrites()) return null;
    if ((await getCatalogStorage().activeRef(language)) === null) return null;
    const handle = await openCatalogDbWritable(language);
    return {
      label: `catalog-${language}-rw`,
      proxy: createProxyCallback(handle.connection),
      afterCommit: isWeb() ? () => handle.flush() : undefined,
      close: () => handle.close()
    };
  },
  release: (language) => closeCatalogDb(language)
} as CatalogSource;

const MANIFEST_MAX_BYTES = 256 * 1024;
const languageOf = (ref: string): CatalogLanguageCode => (/catalog-ja/.test(ref) ? 'ja' : 'en');

/**
 * CatalogInstallPort v2 over apps/mobile/src/platform/pack-install. The adapter only stages bytes and moves files; core validates
 * (`validateCatalogCandidate` over `openForValidation`), journals, and decides rollback from `inspect` (disk truth, never memory).
 */
export function createInstallPort(): CatalogInstallPort {
  return {
    allowDevUrls: import.meta.env.DEV,
    capabilities() {
      const storage = getCatalogStorage();
      const native = storage.kind === 'native-file';
      return {
        fullInstall: true,
        atomicActivation: storage.capabilities.atomicRename,
        attachReads: false,
        catalogWrites: catalogWrites(),
        reason: native ? null : 'The web build keeps the catalog in memory: development and limited mode. Install the app for the full catalog.'
      };
    },
    fetchManifest: (input, signal) => fetchManifestText({ maxBytes: Math.min(input.maxBytes, MANIFEST_MAX_BYTES) }, signal),
    async stage(entry: PackEntry & { language: CatalogLanguageCode }, options): Promise<PackStageResult> {
      const result = await stageCatalogPack(entry, {
        trustedOrigins: options.trustedOrigins,
        signal: options.signal,
        onProgress: (progress) => options.onProgress(progress)
      });
      return { language: result.language, version: result.version, sha256: result.sha256, bytes: result.bytes, candidateRef: result.candidateRef, metrics: result.metrics };
    },
    async openForValidation(ref): Promise<SqlDriver> {
      const language = languageOf(ref);
      const active = await getCatalogStorage().activeRef(language);
      if (active !== null && active === ref) {
        // Validating the ACTIVE file: share the cached read-only connection (closing it here would break live readers).
        const connection = await openCatalogDb(language);
        return { label: `validate-${ref}`, proxy: createProxyCallback(connection), close: async () => undefined };
      }
      const handle = await openCatalogRef(ref);
      return { label: `validate-${ref}`, proxy: createProxyCallback(handle.connection), close: () => handle.close() };
    },
    activate: (language, candidateRef) => getCatalogStorage().activate(language, candidateRef),
    restorePrevious: (language) => getCatalogStorage().restorePrevious(language),
    discardPrevious: (language) => getCatalogStorage().discardPrevious(language),
    discardCandidate: (ref) => getCatalogStorage().discardCandidate(ref),
    inspect: (language): Promise<PackDiskState> => getCatalogStorage().inspect(language),
    remove: (language) => removeCatalog(language)
  };
}
