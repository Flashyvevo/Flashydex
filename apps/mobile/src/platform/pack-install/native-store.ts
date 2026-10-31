import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { CatalogLanguageCode, CatalogReadOnlyHandle, CatalogStagingFile, PlatformCatalogStorage } from '@flashydex/core';
import { getSqlitePlugin } from '../sqlite';
import type { CatalogHandle } from './catalog-handle';

/**
 * Native catalog storage (iOS / Android). NOT executed anywhere yet: verified only by type-check and by reading the plugin sources;
 * see scripts/ios-notes.md for the exact on-device checks.
 *
 * Location (Director rulings S7/D18, binding): catalogs are replaceable and re-downloadable, so they live in a backup-excluded directory
 *  - iOS: `Directory.LibraryNoCloud` = `Library/NoCloud`. ion-ios-filesystem `fetchNotSyncedLibrary` creates it and sets
 *    `isExcludedFromBackup = true` on the directory (source-read). Not `Library/Caches` (purgeable), not Documents.
 *  - Android: `Directory.Library` = app `filesDir`; excluded through `data_extraction_rules.xml` / `backup_rules.xml`
 *    (`flashydex/catalogs`, `flashydex/packs`). `noBackupFilesDir` is not reachable through @capacitor/filesystem.
 * `flashydex-user.db` stays in the plugin's default (backed-up) database location.
 *
 * Files (same directory => same volume => rename is atomic): `catalog-<lang>.db` (active), `catalog-<lang>.previous.db`,
 * `catalog-<lang>-<version>.db.part` (staging/candidate). Opened READ-ONLY with createNCConnection(absolute path).
 */
const ROOT = 'flashydex/catalogs';

function directory(): Directory {
  return Capacitor.getPlatform() === 'ios' ? Directory.LibraryNoCloud : Directory.Library;
}
const activePath = (language: CatalogLanguageCode) => `${ROOT}/catalog-${language}.db`;
const previousPath = (language: CatalogLanguageCode) => `${ROOT}/catalog-${language}.previous.db`;
const partPath = (language: CatalogLanguageCode, version: string) => `${ROOT}/catalog-${language}-${version}.db.part`;

async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: directory() });
    return true;
  } catch {
    return false;
  }
}

async function removeIfExists(path: string): Promise<void> {
  if (await exists(path)) await Filesystem.deleteFile({ path, directory: directory() });
}

async function absolutePath(path: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ path, directory: directory() });
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/** Exact decoded length of a padded base64 string. */
function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

class NativeStagingFile implements CatalogStagingFile {
  readonly chunkEncoding = 'base64' as const;
  private bytes = 0;
  constructor(readonly ref: string) {}
  async append(chunk: Uint8Array | string): Promise<void> {
    if (typeof chunk !== 'string') throw new Error('native staging expects base64 strings');
    await Filesystem.appendFile({ path: this.ref, directory: directory(), data: chunk });
    this.bytes += base64Bytes(chunk);
  }
  async finish(): Promise<{ bytes: number }> {
    const stat = await Filesystem.stat({ path: this.ref, directory: directory() });
    if (stat.size !== this.bytes) throw new Error(`Staged file is ${stat.size} bytes, expected ${this.bytes}`);
    return { bytes: this.bytes };
  }
  async abort(): Promise<void> {
    await removeIfExists(this.ref).catch(() => undefined);
  }
}

async function openReadOnlyNc(path: string): Promise<CatalogHandle> {
  const absolute = await absolutePath(path);
  const sqlite = await getSqlitePlugin();
  // Existence is checked BEFORE open: opening a missing path must never create an empty database.
  if (!(await sqlite.isNCDatabase(absolute)).result) throw new Error('Catalog file is missing');
  const connection = await sqlite.createNCConnection(absolute, 1);
  await connection.open();
  return {
    connection,
    query: (statement, values) => connection.query(statement, values as never[]) as Promise<{ values?: unknown[] }>,
    close: async () => {
      await connection.close().catch(() => undefined);
      await sqlite.closeNCConnection(absolute).catch(() => undefined);
    }
  };
}

export function createNativeCatalogStorage(closeActiveHandle: (language: CatalogLanguageCode) => Promise<void>): PlatformCatalogStorage {
  return {
    kind: 'native-file',
    capabilities: { atomicRename: true, readOnlyOpen: true, backupExcluded: true, streamingWrite: true },

    // @capacitor/filesystem has no free-space API; preflight needs a tiny native plugin (open question). Writes still fail loudly.
    async availableBytes() {
      return null;
    },

    async beginStaging({ language, version }) {
      await Filesystem.mkdir({ path: ROOT, directory: directory(), recursive: true }).catch(() => undefined);
      const listing = await Filesystem.readdir({ path: ROOT, directory: directory() }).catch(() => ({ files: [] }));
      for (const file of listing.files) {
        if (file.name.startsWith(`catalog-${language}-`) && file.name.endsWith('.db.part')) await removeIfExists(`${ROOT}/${file.name}`);
      }
      const ref = partPath(language, version);
      await removeIfExists(ref);
      await Filesystem.writeFile({ path: ref, directory: directory(), data: '', encoding: Encoding.UTF8 });
      return new NativeStagingFile(ref);
    },

    openReadOnly(ref): Promise<CatalogReadOnlyHandle> {
      return openReadOnlyNc(ref);
    },

    async activate(language, candidateRef) {
      await closeActiveHandle(language);
      const dir = directory();
      const hadActive = await exists(activePath(language));
      await removeIfExists(previousPath(language));
      if (hadActive) await Filesystem.rename({ from: activePath(language), to: previousPath(language), directory: dir, toDirectory: dir });
      try {
        await Filesystem.rename({ from: candidateRef, to: activePath(language), directory: dir, toDirectory: dir });
      } catch (error) {
        if (hadActive) await Filesystem.rename({ from: previousPath(language), to: activePath(language), directory: dir, toDirectory: dir }).catch(() => undefined);
        throw error;
      }
      return { activeRef: activePath(language), previousRef: hadActive ? previousPath(language) : null };
    },

    async discardPrevious(language) {
      await removeIfExists(previousPath(language));
    },

    async restorePrevious(language) {
      if (!(await exists(previousPath(language)))) return false;
      await closeActiveHandle(language);
      const dir = directory();
      await removeIfExists(activePath(language));
      await Filesystem.rename({ from: previousPath(language), to: activePath(language), directory: dir, toDirectory: dir });
      return true;
    },

    async activeRef(language) {
      return (await exists(activePath(language))) ? activePath(language) : null;
    },

    async remove(language) {
      await closeActiveHandle(language);
      await removeIfExists(activePath(language));
      await removeIfExists(previousPath(language));
      const listing = await Filesystem.readdir({ path: ROOT, directory: directory() }).catch(() => ({ files: [] }));
      for (const file of listing.files) {
        if (file.name.startsWith(`catalog-${language}-`) && file.name.endsWith('.db.part')) await removeIfExists(`${ROOT}/${file.name}`);
      }
    }
  };
}

/**
 * Writable connection to the active catalog file (price refresh only). NOTE: the native write path is not exercised by the web
 * test-suite; it uses the same non-conformed connection API as the read-only open, without the existence-creating risk.
 */
export async function openWritableNative(path: string): Promise<{ connection: CatalogHandle['connection']; flush(): Promise<void>; close(): Promise<void> }> {
  const handle = await openReadOnlyNc(path); // existence-checked NC connection; NC connections are read-write at the driver level
  return { connection: handle.connection, flush: async () => undefined, close: () => handle.close() };
}
