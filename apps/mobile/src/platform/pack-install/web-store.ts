import type { SqlDriver } from '@flashydex/core';
import { CATALOG_PATH_RE, WebStorageError, type PoolPath, type WebLanguage } from '../web-storage/contract';
import { referencedPaths } from '../web-storage/role-state';
import { getWebRuntime, languageOfCatalogRef, type WebStoreDeps } from '../web-storage/runtime';
import { listStagingJobs, newJobId, removeStagingJob, runOpfsStage } from '../web-storage/opfs-staging';
import type { DeviceInstallMetrics, PackEntryInput, StageOptions, StageProgress, StageResult } from './installer';
import type { StageFaults } from './opfs-stage-protocol';
import { PackInstallError } from './run-worker';
import type { CatalogStorage, DiskState } from './storage-types';

/**
 * Web catalog storage (Stage F, production): catalogs are sahpool files `/catalog-<lang>/g-<job>.db` owned by Sonnet A's worker; the role
 * mappings (active / previous / candidates / import intents) live in the adapter IndexedDB (`RoleStore`). Activation is a LOGICAL atomic
 * pointer switch (one IDB transaction); files are never renamed, copied or overwritten, so `atomicRename` is never advertised.
 * docs/WEB-STORAGE.md §4. Core's journal + barrier + receipt stay the commit authority (this file adapts `CatalogInstallPort` v2).
 */

/**
 * `capabilities().atomicActivation` on web. True because the pointer transition (role-state.ts) is one IDB transaction and every row of the
 * WEB-STORAGE §4 crash table is driven through the UNCHANGED core CatalogInstallService in web-store.test.ts.
 * Earned back (Sol S5-03) only after `e2e/web-install.spec.ts` passed in full twice in a row against REAL IndexedDB + sahpool, including v2 update,
 * rollback, discardPrevious, quota, short write, update killed mid-decode / mid-import and the receipt-COMMIT-unknown tests. Set it to false
 * again whenever any of those goes red: it is the production install gate (web-port.ts).
 */
export const WEB_ATOMIC_ACTIVATION_PROVEN = true;

const MIB = 1024 * 1024;

/** WEB-STORAGE §4: compressed stage + raw stage + sahpool import copy + max(32 MiB, 10% of raw). */
export function requiredFreeBytes(compressedBytes: number, uncompressedBytes: number): number {
  return compressedBytes + 2 * uncompressedBytes + Math.max(32 * MIB, Math.ceil(uncompressedBytes * 0.1));
}

/** Maps the web storage vocabulary onto core's adapter codes (contract §4). */
export function toPackInstallError(error: unknown): PackInstallError {
  if (error instanceof PackInstallError) return error;
  if (error instanceof WebStorageError) {
    switch (error.code) {
      case 'QUOTA':
      case 'CAPACITY':
        return new PackInstallError('STORAGE_FULL', error.message, { cause: error });
      case 'INTEGRITY':
        return new PackInstallError(/size|byte|length/i.test(error.message) ? 'PACK_SIZE_MISMATCH' : 'PACK_HASH_MISMATCH', error.message, { cause: error });
      case 'CANCELLED':
        return new PackInstallError('CANCELLED', error.message, { cause: error });
      case 'INVALID_PATH':
      case 'SQLITE':
        return new PackInstallError('PACK_INVALID', error.message, { cause: error });
      default:
        return new PackInstallError('ACTIVATION_FAILED', error.message, { cause: error });
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') return new PackInstallError('CANCELLED', 'Install cancelled', { cause: error });
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new PackInstallError('STORAGE_FULL', 'The browser storage quota was exceeded', { cause: error });
  return new PackInstallError('ACTIVATION_FAILED', error instanceof Error ? error.message : String(error), { cause: error });
}

export interface WebCatalogStorage extends CatalogStorage {
  readonly kind: 'web-store';
  /** Download -> OPFS staging -> decode -> pool import -> candidate registration. Never activates. */
  stage(entry: PackEntryInput, options: StageOptions): Promise<StageResult>;
  /** Read-only driver for core validation: the active file shares its physical connection, a candidate gets its own. */
  openValidationDriver(ref: PoolPath): Promise<SqlDriver>;
  /** Driver over the ACTIVE catalog of `language` (null when none). `rw` shares the physical connection per A's client. */
  openCatalogDriver(language: WebLanguage, mode: 'ro' | 'rw'): Promise<SqlDriver | null>;
  /** Close every physical handle this storage opened for `language` (CatalogSource.release). */
  releaseLanguage(language: WebLanguage): Promise<void>;
}

function mark(name: string, startEpochMs: number, endEpochMs: number): void {
  try {
    performance.measure(name, { start: startEpochMs - performance.timeOrigin, end: endEpochMs - performance.timeOrigin });
  } catch {
    /* marks are diagnostics only */
  }
}
const epochNow = () => performance.timeOrigin + performance.now();

export function createWebCatalogStorage(deps: () => WebStoreDeps): WebCatalogStorage {
  let cached: WebStoreDeps | undefined;
  const d = (): WebStoreDeps => (cached ??= deps());
  const opened = new Map<WebLanguage, Set<PoolPath>>();
  const track = (language: WebLanguage, path: PoolPath) => {
    const set = opened.get(language) ?? new Set<PoolPath>();
    set.add(path);
    opened.set(language, set);
  };
  const langOf = (ref: string): WebLanguage => {
    const language = languageOfCatalogRef(ref);
    if (!language) throw new PackInstallError('PACK_INVALID', 'Not a catalog reference');
    return language;
  };
  /** Best effort: closes (ignoring errors) then unlinks a file that is no longer referenced. Never throws. */
  const retire = async (ref: PoolPath | null): Promise<void> => {
    if (!ref) return;
    try {
      await d().client.closePath(ref);
    } catch { /* may not be open */ }
    try {
      await d().client.unlink(ref);
    } catch { /* BUSY or absent: boot reconciliation retries from role truth */ }
  };

  async function cleanupFailedJob(job: string, target: PoolPath): Promise<void> {
    try { await d().stagingJobs.remove(job); } catch { /* reconciled at boot */ }
    try {
      const state = await d().roles.load();
      if (!referencedPaths(state).has(target)) {
        const files = await d().client.listFiles();
        if (files.includes(target)) await retire(target);
      }
    } catch { /* reconciled at boot */ }
    try { await d().roles.clearIntent(job); } catch { /* reconciled at boot */ }
  }

  const storage: WebCatalogStorage = {
    kind: 'web-store',
    capabilities: { atomicRename: false, readOnlyOpen: true, backupExcluded: false, streamingWrite: true },

    async availableBytes() {
      const estimate = await navigator.storage?.estimate?.();
      return estimate?.quota !== undefined && estimate.usage !== undefined ? Math.max(0, estimate.quota - estimate.usage) : null;
    },

    beginStaging() {
      return Promise.reject(new PackInstallError('UNSUPPORTED_CAPABILITY', 'The web build stages through the OPFS stage worker, not through a main-thread writer'));
    },
    openReadOnly() {
      return Promise.reject(new PackInstallError('UNSUPPORTED_CAPABILITY', 'Web catalog handles are SqlDrivers (openValidationDriver / openCatalogDriver)'));
    },

    async stage(entry, options): Promise<StageResult> {
      const language = entry.language;
      const started = performance.now();
      const emit = (phase: StageProgress['phase'], compressed: number, decoded: number, pendingBytes?: number) =>
        options.onProgress?.({ phase, compressedBytesDone: compressed, compressedBytesTotal: entry.compressedBytes, decompressedBytesDone: decoded, decompressedBytesTotal: entry.uncompressedBytes, pendingBytes });
      try {
        // 1. disk preflight (free = quota - usage; usage already includes active/previous/cache, so it is never double-counted)
        const estimate = await d().estimate();
        const required = requiredFreeBytes(entry.compressedBytes, entry.uncompressedBytes);
        if (estimate?.quota !== undefined && estimate.usage !== undefined) {
          const free = Math.max(0, estimate.quota - estimate.usage);
          if (free < required) throw new PackInstallError('STORAGE_FULL', `Needs about ${required} free bytes, ${free} available`);
        }
        await d().client.ensureCapacity(4);
        if (options.signal?.aborted) throw new PackInstallError('CANCELLED', 'Install cancelled');

        // 2. intent BEFORE any allocation; the pool path is unique per job
        const job = d().newJobId();
        const target: PoolPath = `/catalog-${language}/g-${job}.db`;
        if (!CATALOG_PATH_RE.test(target)) throw new PackInstallError('ACTIVATION_FAILED', 'Could not allocate a catalog path');
        await d().roles.putIntent({ job, target: language, targetRef: target, stagingJob: job, startedAt: d().now() });
        emit('downloading', 0, 0);
        try {
          // 3. fetch -> staged compressed file -> bounded decode -> staged raw file (worker)
          const done = await d().runStage({
            job,
            url: new URL(entry.fullPackUrl, globalThis.location?.origin ?? 'http://localhost').toString(),
            trustedOrigins: options.trustedOrigins,
            expectedCompressedBytes: entry.compressedBytes,
            expectedUncompressedBytes: entry.uncompressedBytes,
            compressedSha256: entry.compressedSha256,
            expectedSha256: entry.sha256,
            signal: options.signal,
            fault: d().faults?.(),
            onProgress: (phase, compressed, decoded, pending) => emit('downloading', compressed, phase === 'decode' ? decoded : 0, pending)
          });
          mark('fdx:pack-download', done.timestamps.start, done.timestamps.downloadEnd);
          mark('fdx:pack-decode', done.timestamps.downloadEnd, done.timestamps.decodeEnd);
          if (done.decodedBytes !== entry.uncompressedBytes) throw new PackInstallError('PACK_SIZE_MISMATCH', `Decoded ${done.decodedBytes} bytes, manifest says ${entry.uncompressedBytes}`);
          if (done.sha256 !== entry.sha256) throw new PackInstallError('PACK_HASH_MISMATCH', 'Decompressed SHA-256 does not match the manifest');
          if (options.signal?.aborted) throw new PackInstallError('CANCELLED', 'Install cancelled');

          // 4. streamed staged-file -> pool import (A), exact bytes + hash verified there as well
          emit('verifying', entry.compressedBytes, 0);
          const importStart = epochNow();
          const imported = await d().client.importFromStaging({
            source: { job, name: 'catalog.db.part' },
            target,
            expectedBytes: entry.uncompressedBytes,
            expectedSha256: entry.sha256,
            signal: options.signal,
            onProgress: (bytes) => emit('verifying', entry.compressedBytes, bytes)
          });
          mark('fdx:pack-import', importStart, epochNow());
          if (imported.bytes !== entry.uncompressedBytes) throw new PackInstallError('PACK_SIZE_MISMATCH', `Imported ${imported.bytes} bytes, manifest says ${entry.uncompressedBytes}`);
          if (imported.sha256 !== entry.sha256) throw new PackInstallError('PACK_HASH_MISMATCH', 'Imported SHA-256 does not match the manifest');

          // 5. register the candidate, then drop the intent and the ordinary staging files (both best-effort after registration)
          await d().roles.addCandidate(language, { ref: target, job, version: entry.targetVersion, sha256: entry.sha256, bytes: imported.bytes, createdAt: d().now() });
          await d().roles.clearIntent(job).catch(() => undefined);
          await d().stagingJobs.remove(job).catch(() => undefined);

          const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
          const metrics: DeviceInstallMetrics = {
            metricsVersion: 2, language, version: entry.targetVersion, platform: 'web', storageKind: 'web-store',
            compressedBytes: done.compressedBytes, uncompressedBytes: done.decodedBytes,
            streamMs: Math.round(done.timestamps.decodeEnd - done.timestamps.start), verifyMs: Math.round(imported.ms), totalMs: Math.round(performance.now() - started),
            zstdWindowBytes: done.windowBytes, maxInFlightObserved: done.maxInFlightObserved, maxChunkBytes: Math.max(done.maxChunkBytes, imported.maxChunkBytes), pendingBytesMax: done.pendingBytesMax,
            jsHeapUsedBytes: heap, peakMemoryBytes: null,
            phases: { downloadMs: Math.round(done.timestamps.downloadEnd - done.timestamps.start), decodeMs: Math.round(done.timestamps.decodeEnd - done.timestamps.downloadEnd), importMs: Math.round(imported.ms) },
            unavailable: { peakMemoryBytes: 'Worker/WASM memory is measured by the e2e harness through CDP; it is not observable from the page.' }
          };
          return { language, version: entry.targetVersion, sha256: entry.sha256, bytes: imported.bytes, candidateRef: target, metrics };
        } catch (error) {
          await cleanupFailedJob(job, target);
          throw error;
        }
      } catch (error) {
        throw toPackInstallError(error);
      }
    },

    async openValidationDriver(ref) {
      const language = langOf(ref);
      const startedAt = epochNow();
      try {
        const active = (await d().roles.language(language)).activeRef;
        const driver = await d().client.driver(ref, `validate-${ref}`, { mode: 'ro', create: false, role: active === ref ? 'catalog' : 'validation' });
        const close = driver.close.bind(driver);
        // Explicit delegation (A's LogicalDriver is a class instance: spreading it would drop its prototype methods).
        return {
          label: driver.label,
          proxy: (sql, params, method) => driver.proxy(sql, params, method),
          close: async () => {
            try {
              await close();
            } finally {
              if (active !== ref) mark('fdx:pack-validate', startedAt, epochNow());
            }
          }
        };
      } catch (error) {
        throw toPackInstallError(error);
      }
    },

    async openCatalogDriver(language, mode) {
      const active = (await d().roles.language(language)).activeRef;
      if (active === null) return null;
      track(language, active);
      return d().client.driver(active, mode === 'ro' ? `catalog-${language}` : `catalog-${language}-rw`, { mode, create: false, role: 'catalog' });
    },

    async releaseLanguage(language) {
      const paths = new Set(opened.get(language) ?? []);
      opened.delete(language);
      const active = (await d().roles.language(language).catch(() => null))?.activeRef;
      if (active) paths.add(active);
      for (const path of paths) await d().client.closePath(path).catch(() => undefined);
    },

    async activate(language, candidateRef) {
      const startedAt = epochNow();
      try {
        const before = await d().roles.language(language);
        // core already holds the language barrier and retired its handle; stop the physical connection of the OLD active before the switch
        if (before.activeRef !== null) await d().client.closePath(before.activeRef);
        const activated = await d().roles.activate(language, candidateRef, before.activeRef);
        mark('fdx:pack-activate', startedAt, epochNow());
        // an older leftover `previous` was displaced by this transition: it is no longer referenced by anything
        if (before.previousRef !== null && before.previousRef !== activated.previousRef) await retire(before.previousRef);
        return activated;
      } catch (error) {
        throw toPackInstallError(error);
      }
    },

    async restorePrevious(language) {
      try {
        const before = await d().roles.language(language);
        if (before.previousRef === null) return false;
        if (before.activeRef !== null) await d().client.closePath(before.activeRef);
        await d().client.closePath(before.previousRef);
        const restored = await d().roles.restorePrevious(language, before.activeRef);
        if (restored === null) return false;
        await retire(restored.displacedRef); // the rolled-back (or never-committed) generation is unreferenced now
        return true;
      } catch (error) {
        throw toPackInstallError(error);
      }
    },

    async discardPrevious(language) {
      await retire(await d().roles.clearPrevious(language));
    },

    async discardCandidate(ref) {
      const language = languageOfCatalogRef(ref);
      if (!language) throw new PackInstallError('PACK_INVALID', 'Refusing to discard a non-catalog ref');
      // Membership first: a promoted active/previous ref (stale core cleanup after an uncertain COMMIT) is NEVER unlinked.
      if (await d().roles.removeCandidate(language, ref)) await retire(ref);
    },

    async inspect(language): Promise<DiskState> {
      const [roles, files] = await Promise.all([d().roles.language(language), d().client.listFiles()]);
      const present = new Set(files);
      return {
        activeRef: roles.activeRef !== null && present.has(roles.activeRef) ? roles.activeRef : null,
        previousRef: roles.previousRef !== null && present.has(roles.previousRef) ? roles.previousRef : null,
        candidateRefs: roles.candidates.map((candidate) => candidate.ref).filter((ref) => present.has(ref))
      };
    },

    async activeRef(language) {
      const roles = await d().roles.language(language);
      return roles.activeRef;
    },

    async remove(language) {
      const refs = await d().roles.clearLanguage(language);
      opened.delete(language);
      for (const ref of refs) await retire(ref);
    }
  };
  return storage;
}

/** Deps wired to the prepared web runtime (resolved lazily so importing this module never touches storage). */
export function productionWebStoreDeps(): WebStoreDeps {
  const { client, roles } = getWebRuntime();
  return {
    client, roles,
    runStage: runOpfsStage,
    stagingJobs: { list: listStagingJobs, remove: removeStagingJob },
    estimate: async () => navigator.storage?.estimate?.(),
    newJobId,
    now: () => new Date().toISOString(),
    faults: import.meta.env.DEV ? () => (window as unknown as { __flashydexTest?: { webInstallFault?: StageFaults } }).__flashydexTest?.webInstallFault : undefined
  };
}
