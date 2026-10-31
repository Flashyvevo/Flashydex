import { Capacitor } from '@capacitor/core';
import { CATALOG_SCHEMA_VERSION } from '@flashydex/core/catalog-schema';
import type {
  CatalogLanguageCode, CatalogManifestEntry, CatalogReadOnlyHandle, PackInstallProgress, PlatformCatalogStorage
} from '@flashydex/core';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { CatalogHandle } from './catalog-handle';
import { createNativeCatalogStorage, openWritableNative } from './native-store';
import { PackInstallError, runPackWorker } from './run-worker';
import { createWebCatalogStorage, openWritableWeb } from './web-store';

export { PackInstallError } from './run-worker';

/** A manifest language entry plus the language it belongs to (the manifest keys entries by language). */
export type CatalogPackEntry = CatalogManifestEntry & { language: CatalogLanguageCode };

export interface InstallOptions {
  onProgress?: (progress: PackInstallProgress) => void;
  signal?: AbortSignal;
}

export interface CatalogCounts { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number }

export interface DeviceInstallMetrics {
  metricsVersion: 1;
  language: CatalogLanguageCode;
  version: string;
  platform: 'ios' | 'android' | 'web';
  storageKind: PlatformCatalogStorage['kind'];
  compressedBytes: number;
  uncompressedBytes: number;
  /** Fetch + zstd decode + SHA-256 + chunk writes, worker start to completion. */
  streamMs: number;
  verifyMs: number;
  validateMs: number;
  activateMs: number;
  totalMs: number;
  zstdWindowBytes: number;
  maxInFlightObserved: number;
  maxChunkBytes: number;
  /** Main-thread JS heap after the install (Chromium only). */
  jsHeapUsedBytes: number | null;
  /** Native process / worker / WASM peak RSS is not observable from JS: null + reason, never invented. */
  peakMemoryBytes: null;
  unavailable: Record<string, string>;
}

export interface InstallResult {
  language: CatalogLanguageCode;
  version: string;
  /** SHA-256 of the decompressed bytes, verified equal to the manifest. */
  sha256: string;
  bytes: number;
  /** Opaque active-file reference (never exported or displayed). */
  ref: string;
  /** Retained previous copy until finalizeCatalogInstall / rollbackCatalogInstall; null on first install. */
  previousRef: string | null;
  /** Row counts read back from the opened catalog (compared with the manifest). */
  counts: CatalogCounts;
  metrics: DeviceInstallMetrics;
}

const handles = new Map<CatalogLanguageCode, CatalogHandle>();
let storageInstance: PlatformCatalogStorage | undefined;
let installing = false;

async function closeCatalogHandle(language: CatalogLanguageCode): Promise<void> {
  const handle = handles.get(language);
  handles.delete(language);
  if (handle) await handle.close().catch(() => undefined);
}

export function getCatalogStorage(): PlatformCatalogStorage {
  storageInstance ??= Capacitor.getPlatform() === 'web' ? createWebCatalogStorage(closeCatalogHandle) : createNativeCatalogStorage(closeCatalogHandle);
  return storageInstance;
}

const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/;

/** Resolve a manifest URL. Production requires https; same-origin relative and http are allowed only in DEV (Director D27). */
export function resolvePackUrl(url: string): string {
  if (url.startsWith('https://')) return url;
  if (import.meta.env.DEV && (url.startsWith('/') || url.startsWith('http://'))) return new URL(url, window.location.origin).toString();
  throw new PackInstallError('PACK_INVALID', 'Pack URL must be https');
}

function assertEntry(entry: CatalogPackEntry): void {
  if (entry.language !== 'en' && entry.language !== 'ja') throw new PackInstallError('PACK_INVALID', 'Unsupported catalog language');
  if (!VERSION.test(entry.targetVersion)) throw new PackInstallError('PACK_INVALID', 'Invalid catalog version');
  if (!HEX64.test(entry.sha256) || (entry.compressedSha256 !== undefined && !HEX64.test(entry.compressedSha256))) throw new PackInstallError('PACK_INVALID', 'Invalid pack hash');
  for (const bytes of [entry.compressedBytes, entry.uncompressedBytes]) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new PackInstallError('PACK_INVALID', 'Invalid pack size');
  }
  // CATALOG-PACKS phase-1 caps: never trust enormous manifest claims.
  if (entry.uncompressedBytes > 512 * 1024 * 1024 || entry.compressedBytes > 256 * 1024 * 1024) throw new PackInstallError('PACK_INVALID', 'Pack exceeds the supported size');
  if (entry.schemaVersion > CATALOG_SCHEMA_VERSION) throw new PackInstallError('APP_UPDATE_REQUIRED', `Catalog schema ${entry.schemaVersion} needs a newer app`);
  if (!entry.fullPackUrl.endsWith(`catalog-${entry.language}-${entry.targetVersion}.db.zst`)) throw new PackInstallError('PACK_INVALID', 'Pack URL does not match language/version');
}

/** Rows come back as objects; iOS prepends a `{ios_columns}` pseudo-row. */
function firstRow(values: unknown[] | undefined): Record<string, unknown> | undefined {
  return (values ?? []).find((row) => typeof row === 'object' && row !== null && !('ios_columns' in row)) as Record<string, unknown> | undefined;
}

async function readCounts(handle: CatalogReadOnlyHandle): Promise<CatalogCounts> {
  const one = async (sql: string) => Number(firstRow((await handle.query(sql)).values)?.n);
  return {
    sets: await one('SELECT COUNT(*) AS n FROM catalog_sets'),
    cards: await one('SELECT COUNT(*) AS n FROM catalog_cards'),
    variants: await one('SELECT COUNT(*) AS n FROM catalog_variants'),
    prices: await one('SELECT COUNT(*) AS n FROM catalog_latest_prices'),
    unpublishedSets: await one("SELECT COUNT(*) AS n FROM catalog_sets WHERE status = 'unpublished'")
  };
}

/** Bundled validation queries only (no SQL from the pack or manifest). */
async function validateCatalog(handle: CatalogReadOnlyHandle, entry: CatalogPackEntry): Promise<CatalogCounts> {
  const meta = firstRow((await handle.query('SELECT language, version, schema_version FROM catalog_meta')).values);
  if (!meta) throw new PackInstallError('PACK_INVALID', 'catalog_meta is missing');
  if (meta.language !== entry.language || meta.version !== entry.targetVersion) throw new PackInstallError('PACK_INVALID', 'catalog_meta does not match the manifest');
  if (Number(meta.schema_version) > CATALOG_SCHEMA_VERSION) throw new PackInstallError('APP_UPDATE_REQUIRED', 'Catalog schema is newer than this app supports');
  const foreign = firstRow((await handle.query('SELECT COUNT(*) AS n FROM catalog_cards WHERE language <> ?', [entry.language])).values);
  if (Number(foreign?.n) !== 0) throw new PackInstallError('PACK_INVALID', 'Catalog contains rows of another language');
  const counts = await readCounts(handle);
  for (const key of Object.keys(counts) as Array<keyof CatalogCounts>) {
    if (counts[key] !== entry.counts[key]) throw new PackInstallError('PACK_INVALID', `Catalog ${key} count ${counts[key]} does not match the manifest (${entry.counts[key]})`);
  }
  // quick_check is best-effort: some driver builds do not return PRAGMA rows through query().
  try {
    const check = firstRow((await handle.query('PRAGMA quick_check')).values);
    const verdict = check ? Object.values(check)[0] : undefined;
    if (verdict !== undefined && verdict !== 'ok') throw new PackInstallError('PACK_INVALID', `quick_check: ${String(verdict)}`);
  } catch (error) {
    if (error instanceof PackInstallError) throw error;
  }
  return counts;
}

/**
 * Download -> streaming decode -> SHA-256 -> staged file -> verify -> validate -> atomic activate.
 * A failed or cancelled install never touches the active catalog. The previous copy is kept (see `previousRef`) until the caller
 * runs `finalizeCatalogInstall` after its own durable commit, or `rollbackCatalogInstall` on failure.
 */
export async function installCatalogPack(entry: CatalogPackEntry, options: InstallOptions = {}): Promise<InstallResult> {
  assertEntry(entry);
  if (installing) throw new PackInstallError('ACTIVATION_FAILED', 'Another catalog install is running');
  installing = true;
  const started = performance.now();
  const storage = getCatalogStorage();
  const { language } = entry;
  const emit = (phase: PackInstallProgress['phase'], compressed = entry.compressedBytes, decoded = entry.uncompressedBytes) =>
    options.onProgress?.({ phase, compressedBytesDone: compressed, compressedBytesTotal: entry.compressedBytes, decompressedBytesDone: decoded, decompressedBytesTotal: entry.uncompressedBytes });
  try {
    const available = await storage.availableBytes();
    const required = entry.uncompressedBytes + Math.max(32 * 1024 * 1024, Math.ceil(entry.uncompressedBytes * 0.1));
    if (available !== null && available < required) throw new PackInstallError('STORAGE_FULL', `Needs about ${required} free bytes, ${available} available`);

    emit('downloading', 0, 0);
    const staging = await storage.beginStaging({ language, version: entry.targetVersion, expectedBytes: entry.uncompressedBytes });
    let candidateKept = false;
    try {
      const done = await runPackWorker({
        url: resolvePackUrl(entry.fullPackUrl),
        expectedCompressedBytes: entry.compressedBytes,
        expectedUncompressedBytes: entry.uncompressedBytes,
        compressedSha256: entry.compressedSha256,
        staging,
        signal: options.signal,
        onProgress: (compressed, decoded) => emit('downloading', compressed, decoded)
      });

      emit('verifying');
      const verifyStarted = performance.now();
      const { bytes } = await staging.finish();
      if (bytes !== entry.uncompressedBytes) throw new PackInstallError('PACK_SIZE_MISMATCH', `Wrote ${bytes} bytes, manifest says ${entry.uncompressedBytes}`);
      if (done.sha256 !== entry.sha256) throw new PackInstallError('PACK_HASH_MISMATCH', 'Decompressed SHA-256 does not match the manifest');
      const verifyMs = Math.round(performance.now() - verifyStarted);

      emit('validating');
      const validateStarted = performance.now();
      const candidate = await storage.openReadOnly(staging.ref);
      try {
        await validateCatalog(candidate, entry);
      } finally {
        await candidate.close().catch(() => undefined);
      }
      const validateMs = Math.round(performance.now() - validateStarted);

      emit('activating');
      const activateStarted = performance.now();
      const activated = await storage.activate(language, staging.ref);
      candidateKept = true;
      let counts: CatalogCounts;
      try {
        const active = (await storage.openReadOnly(activated.activeRef)) as CatalogHandle;
        counts = await validateCatalog(active, entry);
        handles.set(language, active);
      } catch (error) {
        await closeCatalogHandle(language);
        await storage.restorePrevious(language).catch(() => undefined);
        throw error instanceof PackInstallError ? error : new PackInstallError('ACTIVATION_FAILED', `Activated catalog failed validation: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      const activateMs = Math.round(performance.now() - activateStarted);
      emit('installed');

      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      return {
        language, version: entry.targetVersion, sha256: done.sha256, bytes, ref: activated.activeRef, previousRef: activated.previousRef, counts,
        metrics: {
          metricsVersion: 1, language, version: entry.targetVersion, platform: Capacitor.getPlatform() as 'ios' | 'android' | 'web', storageKind: storage.kind,
          compressedBytes: done.compressedBytes, uncompressedBytes: done.decodedBytes, streamMs: done.streamMs, verifyMs, validateMs, activateMs,
          totalMs: Math.round(performance.now() - started), zstdWindowBytes: done.windowBytes, maxInFlightObserved: done.maxInFlightObserved,
          maxChunkBytes: done.maxChunkBytes, jsHeapUsedBytes: heap, peakMemoryBytes: null,
          unavailable: { peakMemoryBytes: 'Native process/worker/WASM RSS is not observable from JavaScript; measure with Xcode Instruments on device.' }
        }
      };
    } catch (error) {
      if (!candidateKept) await staging.abort().catch(() => undefined);
      throw error;
    }
  } finally {
    installing = false;
  }
}

/** Call after the durable commit (installed_catalogs row): deletes the retained previous copy. */
export function finalizeCatalogInstall(language: CatalogLanguageCode): Promise<void> {
  return getCatalogStorage().discardPrevious(language);
}

/** Restore the previous catalog (activation succeeded here but the caller's commit failed). False when there is none. */
export async function rollbackCatalogInstall(language: CatalogLanguageCode): Promise<boolean> {
  await closeCatalogHandle(language);
  return getCatalogStorage().restorePrevious(language);
}

export async function isCatalogInstalled(language: CatalogLanguageCode): Promise<boolean> {
  return (await getCatalogStorage().activeRef(language)) !== null;
}

/** Read-only driver connection to the ACTIVE catalog for `language` (cached). Throws PACK_INVALID when nothing is installed. */
export async function openCatalogDb(language: CatalogLanguageCode): Promise<SQLiteDBConnection> {
  const cached = handles.get(language);
  if (cached) return cached.connection;
  const storage = getCatalogStorage();
  const ref = await storage.activeRef(language);
  if (!ref) throw new PackInstallError('PACK_INVALID', `No ${language} catalog is installed`);
  const handle = (await storage.openReadOnly(ref)) as CatalogHandle;
  handles.set(language, handle);
  return handle.connection;
}

export async function closeCatalogDb(language: CatalogLanguageCode): Promise<void> {
  await closeCatalogHandle(language);
}

/** Delete the active catalog, previous copy and staging leftovers for a language. */
export async function removeCatalog(language: CatalogLanguageCode): Promise<void> {
  await getCatalogStorage().remove(language);
}

/** Read-write handle to the ACTIVE catalog, for `SyncService` price refresh. Caller closes it. */
export async function openCatalogDbWritable(language: CatalogLanguageCode): Promise<{ connection: SQLiteDBConnection; flush(): Promise<void>; close(): Promise<void> }> {
  const storage = getCatalogStorage();
  const ref = await storage.activeRef(language);
  if (!ref) throw new PackInstallError('PACK_INVALID', `No ${language} catalog is installed`);
  return storage.kind === 'web-store' ? openWritableWeb(ref) : openWritableNative(ref);
}
