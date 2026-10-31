import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { getSqlitePlugin } from '../sqlite';
import type { CatalogHandle, CatalogLanguageCode, CatalogStagingFile, CatalogStorage, DiskState } from './storage-types';

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
 *
 * `inspect` (R06) is pure disk truth (Filesystem.stat / readdir) - no in-memory Set survives a restart, none is used.
 *
 * ── Native writable catalog design (R04 / D44; NOT enabled) ────────────────────────────────────────────────────────────
 * Source-proven problem: `createNCConnection` builds `SQLiteDBConnection(..., readonly = true, ...)`; the plugin rejects execute/run on it,
 * so the NC handle can never be the writer. Chosen design (needs a Mac run to prove, hence `NATIVE_CATALOG_WRITES = false`):
 *   1. WRITE COPY: copy the active file `catalog-<lang>.db` into the plugin's writable databases directory as the logical
 *      database `catalog-<lang>-rw` (iOS: `Library/CapacitorDatabase/catalog-<lang>-rwSQLite.db`; Android: the app `databases/`
 *      directory, which @capacitor/filesystem cannot reach - an Android copy needs a plugin path/copy API, so Android stays disabled).
 *   2. OPEN: `createConnection('catalog-<lang>-rw', false, 'no-encryption', 1, false)` + `open()` = a conformed read-write connection.
 *   3. COMMIT BACK: after the sync run commits, close the connection (plugin checkpoints the WAL), copy the rw file to a staging
 *      `catalog-<lang>-<writeback>.db.part` in the catalog directory and `activate()` it like any candidate (previous retained),
 *      so the backup-excluded active file is replaced by same-volume rename and the old bytes stay recoverable.
 *   4. CLEAN UP: delete the rw copy (it sits in the BACKED-UP plugin directory, so it must not linger) after step 3 or on boot.
 * NC stays read-only and is the only handle used for candidate/read validation. Until steps 1-4 are proven on iOS and Android,
 * the port reports `catalogWrites:false` and `CatalogSource.writable=false`, so prices_only/refresh/incremental show disabled.
 */
export const NATIVE_CATALOG_WRITES = false; // TODO(R04-mac): flip only after scripts/ios-notes.md "Native writable catalog (R04)" passes.

const ROOT = 'flashydex/catalogs';

function directory(): Directory {
  return Capacitor.getPlatform() === 'ios' ? Directory.LibraryNoCloud : Directory.Library;
}
const activePath = (language: CatalogLanguageCode) => `${ROOT}/catalog-${language}.db`;
const previousPath = (language: CatalogLanguageCode) => `${ROOT}/catalog-${language}.previous.db`;
const partPath = (language: CatalogLanguageCode, version: string) => `${ROOT}/catalog-${language}-${version}.db.part`;
const isPartRef = (ref: string) => /^flashydex\/catalogs\/catalog-(en|ja)-[^/]+\.db\.part$/.test(ref);

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

async function partsFor(language: CatalogLanguageCode): Promise<string[]> {
  const listing = await Filesystem.readdir({ path: ROOT, directory: directory() }).catch(() => ({ files: [] }));
  return listing.files
    .filter((file) => file.name.startsWith(`catalog-${language}-`) && file.name.endsWith('.db.part'))
    .map((file) => `${ROOT}/${file.name}`);
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

export function createNativeCatalogStorage(closeActiveHandle: (language: CatalogLanguageCode) => Promise<void>): CatalogStorage {
  return {
    kind: 'native-file',
    capabilities: { atomicRename: true, readOnlyOpen: true, backupExcluded: true, streamingWrite: true },

    // @capacitor/filesystem has no free-space API; preflight needs a tiny native plugin (open question). Writes still fail loudly.
    async availableBytes() {
      return null;
    },

    async beginStaging({ language, version }) {
      await Filesystem.mkdir({ path: ROOT, directory: directory(), recursive: true }).catch(() => undefined);
      for (const part of await partsFor(language)) await removeIfExists(part);
      const ref = partPath(language, version);
      await Filesystem.writeFile({ path: ref, directory: directory(), data: '', encoding: Encoding.UTF8 });
      return new NativeStagingFile(ref);
    },

    openReadOnly(ref) {
      return openReadOnlyNc(ref);
    },

    async activate(language, candidateRef) {
      if (!isPartRef(candidateRef) || !(await exists(candidateRef))) throw new Error('Candidate catalog is missing');
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

    async discardCandidate(ref) {
      if (!isPartRef(ref)) throw new Error('Refusing to discard a non-candidate ref');
      await removeIfExists(ref);
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

    async inspect(language): Promise<DiskState> {
      return {
        activeRef: (await exists(activePath(language))) ? activePath(language) : null,
        previousRef: (await exists(previousPath(language))) ? previousPath(language) : null,
        candidateRefs: await partsFor(language)
      };
    },

    async remove(language) {
      await closeActiveHandle(language);
      await removeIfExists(activePath(language));
      await removeIfExists(previousPath(language));
      for (const part of await partsFor(language)) await removeIfExists(part);
    }
  };
}

/**
 * Writable catalog on native: design above, deliberately NOT wired. Throws UNSUPPORTED_CAPABILITY-shaped error so nothing can
 * silently fall back to the read-only NC handle (the R04 defect).
 */
export async function openWritableNative(_language: CatalogLanguageCode): Promise<{ connection: CatalogHandle['connection']; flush(): Promise<void>; close(): Promise<void> }> {
  void _language;
  throw Object.assign(new Error('Native catalog writes are not enabled yet (needs on-device proof, R04)'), { code: 'UNSUPPORTED_CAPABILITY' });
}
