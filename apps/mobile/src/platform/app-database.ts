import type { CatalogInstallPort, CatalogSource, PackEntry, PackInstallResult, SqlDriver } from '@flashydex/core';
import { Capacitor } from '@capacitor/core';
import { closeLogicalConnection, flushWebStore, openLogicalConnection, USER_DB_NAME } from './sqlite';
import { createProxyCallback } from './sqlite-proxy';
import {
  closeCatalogDb, finalizeCatalogInstall, getCatalogStorage, installCatalogPack, manifestUrl, openCatalogDb, openCatalogDbWritable, removeCatalog, resolvePackUrl,
  rollbackCatalogInstall, PackInstallError
} from './pack-install';

/** The user DB as a core `SqlDriver`: one connection, sqlite-proxy callback, web store flushed after every committed transaction. */
export async function createUserDriver(): Promise<SqlDriver> {
  const connection = await openLogicalConnection(USER_DB_NAME);
  const web = Capacitor.getPlatform() === 'web';
  return {
    label: USER_DB_NAME,
    proxy: createProxyCallback(connection),
    afterCommit: web ? () => flushWebStore(USER_DB_NAME) : undefined,
    close: () => closeLogicalConnection(USER_DB_NAME)
  };
}

/** Catalog connections are read-only handles owned by the pack installer; an absent catalog is `null`, never created. */
export const catalogSource: CatalogSource = {
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
    if ((await getCatalogStorage().activeRef(language)) === null) return null;
    const handle = await openCatalogDbWritable(language);
    const web = Capacitor.getPlatform() === 'web';
    return {
      label: `catalog-${language}-rw`,
      proxy: createProxyCallback(handle.connection),
      afterCommit: web ? () => handle.flush() : undefined,
      close: () => handle.close()
    };
  },
  release: (language) => closeCatalogDb(language)
};

const MANIFEST_MAX_BYTES = 256 * 1024;

/** CatalogInstallPort over apps/mobile/src/platform/pack-install (streamed download -> zstd -> SHA-256 -> staged file -> activate). */
export function createInstallPort(): CatalogInstallPort {
  const pendingPrevious = new Set<'en' | 'ja'>();
  return {
    allowDevUrls: import.meta.env.DEV,
    capabilities() {
      const storage = getCatalogStorage();
      const native = storage.kind === 'native-file';
      return {
        fullInstall: true,
        atomicActivation: storage.capabilities.atomicRename,
        attachReads: false,
        reason: native ? null : 'The web build keeps the catalog in memory: development and limited mode. Install the app for the full catalog.'
      };
    },
    async fetchManifest(signal) {
      const url = manifestUrl();
      if (!url) throw new PackInstallError('HTTP_FAILED', 'No catalog manifest URL is configured');
      let response: Response;
      try {
        response = await fetch(resolvePackUrl(url), { signal, cache: 'no-store' });
      } catch (error) {
        if (signal?.aborted) throw new PackInstallError('CANCELLED', 'Cancelled');
        throw new PackInstallError('HTTP_FAILED', `Manifest request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) throw new PackInstallError('HTTP_FAILED', `Manifest HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MANIFEST_MAX_BYTES) throw new PackInstallError('PACK_INVALID', 'The catalog manifest is too large');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new PackInstallError('PACK_INVALID', 'The catalog manifest is not valid JSON');
      }
    },
    async install(entry: PackEntry, options): Promise<PackInstallResult> {
      const result = await installCatalogPack(entry, { signal: options.signal, onProgress: options.onProgress });
      if (result.previousRef) pendingPrevious.add(entry.language);
      return { ...result, metrics: result.metrics };
    },
    async finalize(language) {
      pendingPrevious.delete(language);
      await finalizeCatalogInstall(language);
    },
    async rollback(language) {
      const restored = await rollbackCatalogInstall(language);
      if (restored) pendingPrevious.delete(language);
      return restored;
    },
    async hasPrevious(language) {
      return pendingPrevious.has(language);
    },
    remove: (language) => removeCatalog(language),
    activeRef: (language) => getCatalogStorage().activeRef(language)
  };
}
