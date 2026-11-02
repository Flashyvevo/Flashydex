import { Capacitor } from '@capacitor/core';
import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { CatalogHandle, CatalogLanguageCode, CatalogStorage } from './storage-types';
import { createNativeCatalogStorage, openWritableNative } from './native-store';
import { PackInstallError, runPackWorker } from './run-worker';
import { createWebCatalogStorage, productionWebStoreDeps, type WebCatalogStorage } from './web-store';

export { PackInstallError } from './run-worker';

/**
 * Device-side pack STAGING (Stage D). This module downloads, bounded-decodes (R05), hashes and writes a candidate file; it does
 * NOT validate SQL contents and does NOT activate. Core owns validation (`validateCatalogCandidate` over `openForValidation`),
 * activation ordering, the journal and rollback (CatalogInstallPort v2). Sanity checks here are only about not allocating or
 * writing beyond what the manifest claims.
 */
export interface PackEntryInput {
  language: CatalogLanguageCode;
  targetVersion: string;
  fullPackUrl: string;
  sha256: string;
  compressedSha256?: string;
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface StageProgress {
  phase: 'downloading' | 'verifying';
  compressedBytesDone: number;
  compressedBytesTotal: number;
  decompressedBytesDone: number;
  decompressedBytesTotal: number;
  pendingBytes?: number;
}

export interface StageOptions {
  trustedOrigins: string[];
  onProgress?: (progress: StageProgress) => void;
  signal?: AbortSignal;
}

export interface DeviceInstallMetrics {
  metricsVersion: 2;
  language: CatalogLanguageCode;
  version: string;
  platform: 'ios' | 'android' | 'web';
  storageKind: CatalogStorage['kind'];
  compressedBytes: number;
  uncompressedBytes: number;
  /** Fetch + zstd decode + SHA-256 + chunk writes, worker start to completion. */
  streamMs: number;
  verifyMs: number;
  totalMs: number;
  zstdWindowBytes: number;
  maxInFlightObserved: number;
  maxChunkBytes: number;
  /** Web only: per-phase wall time (download / bounded decode / pool import). */
  phases?: { downloadMs: number; decodeMs: number; importMs: number };
  /** High-water mark of decoded bytes queued or posted but unacknowledged inside the worker (R05). */
  pendingBytesMax: number;
  /** Main-thread JS heap after the stage (Chromium only). */
  jsHeapUsedBytes: number | null;
  /** Native process / worker / WASM peak RSS is not observable from JS: null + reason, never invented. */
  peakMemoryBytes: null;
  unavailable: Record<string, string>;
}

export interface StageResult {
  language: CatalogLanguageCode;
  version: string;
  /** SHA-256 of the decompressed bytes, verified equal to the manifest. */
  sha256: string;
  bytes: number;
  candidateRef: string;
  metrics: DeviceInstallMetrics;
}

const handles = new Map<CatalogLanguageCode, CatalogHandle>();
let storageInstance: CatalogStorage | undefined;
let staging = false;

async function closeCatalogHandle(language: CatalogLanguageCode): Promise<void> {
  const handle = handles.get(language);
  handles.delete(language);
  if (handle) await handle.close().catch(() => undefined);
}

export function getCatalogStorage(): CatalogStorage {
  storageInstance ??= Capacitor.getPlatform() === 'web' ? createWebCatalogStorage(productionWebStoreDeps) : createNativeCatalogStorage(closeCatalogHandle);
  return storageInstance;
}

/** The web storage (SqlDriver-based handles, role store); only valid on web. */
export function getWebCatalogStorage(): WebCatalogStorage {
  const storage = getCatalogStorage();
  if (storage.kind !== 'web-store') throw new PackInstallError('UNSUPPORTED_CAPABILITY', 'Not a web build');
  return storage as WebCatalogStorage;
}

/** Relative URLs (dev packs) resolve against the page origin. Origin trust is checked on the FINAL response URL by the worker. */
export function resolvePackUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

/** Sizes only: never allocate or write beyond what the manifest claims (CATALOG-PACKS phase-1 caps). Everything semantic is core's. */
function assertEntrySizes(entry: PackEntryInput): void {
  for (const bytes of [entry.compressedBytes, entry.uncompressedBytes]) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new PackInstallError('PACK_INVALID', 'Invalid pack size');
  }
  if (entry.uncompressedBytes > 512 * 1024 * 1024 || entry.compressedBytes > 256 * 1024 * 1024) throw new PackInstallError('PACK_INVALID', 'Pack exceeds the supported size');
}

/** Download -> bounded decode -> SHA-256 -> staged candidate. A failed or cancelled stage leaves no candidate and never touches the active catalog. */
export async function stageCatalogPack(entry: PackEntryInput, options: StageOptions): Promise<StageResult> {
  assertEntrySizes(entry);
  if (staging) throw new PackInstallError('ACTIVATION_FAILED', 'Another catalog install is running');
  staging = true;
  const started = performance.now();
  const storage = getCatalogStorage();
  const { language } = entry;
  const emit = (phase: StageProgress['phase'], compressed = entry.compressedBytes, decoded = entry.uncompressedBytes, pendingBytes?: number) =>
    options.onProgress?.({ phase, compressedBytesDone: compressed, compressedBytesTotal: entry.compressedBytes, decompressedBytesDone: decoded, decompressedBytesTotal: entry.uncompressedBytes, pendingBytes });
  try {
    // Web: the whole pipeline (preflight, intent, OPFS stage worker, pool import, candidate registration) lives in web-store.ts.
    if (storage.kind === 'web-store') return await (storage as WebCatalogStorage).stage(entry, options);
    const available = await storage.availableBytes();
    const required = entry.uncompressedBytes + Math.max(32 * 1024 * 1024, Math.ceil(entry.uncompressedBytes * 0.1));
    if (available !== null && available < required) throw new PackInstallError('STORAGE_FULL', `Needs about ${required} free bytes, ${available} available`);

    emit('downloading', 0, 0);
    const file = await storage.beginStaging({ language, version: entry.targetVersion, expectedBytes: entry.uncompressedBytes });
    try {
      const done = await runPackWorker({
        url: resolvePackUrl(entry.fullPackUrl),
        trustedOrigins: options.trustedOrigins,
        expectedCompressedBytes: entry.compressedBytes,
        expectedUncompressedBytes: entry.uncompressedBytes,
        compressedSha256: entry.compressedSha256,
        staging: file,
        signal: options.signal,
        onProgress: (compressed, decoded, pending) => emit('downloading', compressed, decoded, pending)
      });
      emit('verifying');
      const verifyStarted = performance.now();
      const { bytes } = await file.finish();
      if (bytes !== entry.uncompressedBytes) throw new PackInstallError('PACK_SIZE_MISMATCH', `Wrote ${bytes} bytes, manifest says ${entry.uncompressedBytes}`);
      if (done.sha256 !== entry.sha256) throw new PackInstallError('PACK_HASH_MISMATCH', 'Decompressed SHA-256 does not match the manifest');
      const verifyMs = Math.round(performance.now() - verifyStarted);
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      return {
        language, version: entry.targetVersion, sha256: done.sha256, bytes, candidateRef: file.ref,
        metrics: {
          metricsVersion: 2, language, version: entry.targetVersion, platform: Capacitor.getPlatform() as 'ios' | 'android' | 'web', storageKind: storage.kind,
          compressedBytes: done.compressedBytes, uncompressedBytes: done.decodedBytes, streamMs: done.streamMs, verifyMs,
          totalMs: Math.round(performance.now() - started), zstdWindowBytes: done.windowBytes, maxInFlightObserved: done.maxInFlightObserved,
          maxChunkBytes: done.maxChunkBytes, pendingBytesMax: done.pendingBytesMax, jsHeapUsedBytes: heap, peakMemoryBytes: null,
          unavailable: { peakMemoryBytes: 'Native process/worker/WASM RSS is not observable from JavaScript; measure with Xcode Instruments on device.' }
        }
      };
    } catch (error) {
      await file.abort().catch(() => undefined);
      throw error;
    }
  } finally {
    staging = false;
  }
}

/** Read-only driver connection to the ACTIVE catalog for `language` (cached). Throws PACK_INVALID when nothing is installed. */
export async function openCatalogDb(language: CatalogLanguageCode): Promise<SQLiteDBConnection> {
  if (getCatalogStorage().kind === 'web-store') throw new PackInstallError('UNSUPPORTED_CAPABILITY', 'Web catalogs open as SqlDrivers through catalogSource');
  const cached = handles.get(language);
  if (cached) return cached.connection;
  const storage = getCatalogStorage();
  const ref = await storage.activeRef(language);
  if (!ref) throw new PackInstallError('PACK_INVALID', `No ${language} catalog is installed`);
  const handle = await storage.openReadOnly(ref);
  handles.set(language, handle);
  return handle.connection;
}

export async function closeCatalogDb(language: CatalogLanguageCode): Promise<void> {
  await closeCatalogHandle(language);
}

export async function isCatalogInstalled(language: CatalogLanguageCode): Promise<boolean> {
  return (await getCatalogStorage().activeRef(language)) !== null;
}

/** Delete the active catalog, previous copy and staging leftovers for a language. */
export async function removeCatalog(language: CatalogLanguageCode): Promise<void> {
  await getCatalogStorage().remove(language);
}

export interface WritableCatalog { connection: SQLiteDBConnection; flush(): Promise<void>; close(): Promise<void> }

/** Read-write handle to the ACTIVE catalog, for `SyncService` catalog writes. Caller closes it. Web only until R04-mac. */
export async function openCatalogDbWritable(language: CatalogLanguageCode): Promise<WritableCatalog> {
  const storage = getCatalogStorage();
  const ref = await storage.activeRef(language);
  if (!ref) throw new PackInstallError('PACK_INVALID', `No ${language} catalog is installed`);
  if (storage.kind === 'web-store') throw new PackInstallError('UNSUPPORTED_CAPABILITY', 'Web catalogs open as SqlDrivers through catalogSource');
  return openWritableNative(language);
}

/** Open a read-only handle over any ref (candidate or active) for core validation. The caller closes it. */
export function openCatalogRef(ref: string): Promise<CatalogHandle> {
  return getCatalogStorage().openReadOnly(ref);
}
