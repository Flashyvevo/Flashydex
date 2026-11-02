import { fdxMeasures } from '../data/bootstrap';
import { acquireInstanceLock } from '../platform/instance-lock';
import { catalogRoles, lastPackMetrics, webSqliteClient } from './storage-bridge';
import { imageCache, storageProtection } from './pwa-bridge';
import { isNative } from './native';

/** Chromium-only main-thread heap numbers. Everything else reports a reason instead of an invented value. */
function mainMemory(): { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } | string {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } : 'unavailable in this browser';
}

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? `${(e as { code?: string }).code ?? e.name}` : 'failed' };
  }
}

export type Diagnostics = Record<string, unknown>;

/**
 * Diagnostics snapshot (WEB-STORAGE §6, W07/W14). NEVER includes SQL text, notes, owned-card rows or ids: only versions, byte counts,
 * pool file names (opaque ids), timings and error codes.
 */
export async function collectDiagnostics(): Promise<Diagnostics> {
  const client = webSqliteClient();
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const protection = await safe(async () => storageProtection.check());
  const info = client ? await safe(() => client.init()) : null;
  const stats = client ? await safe(() => client.stats()) : null;
  const art = await safe(() => imageCache.stats());
  const roles = await safe(async () => {
    const r = await catalogRoles();
    if (!r) return null;
    return Object.fromEntries(
      (Object.keys(r) as Array<keyof typeof r>).map((l) => [l, { activeRef: r[l].activeRef, previousRef: r[l].previousRef, candidates: r[l].candidates.map((c) => ({ ref: c.ref, version: c.version, bytes: c.bytes })) }])
    );
  });
  const lock = await acquireInstanceLock();
  const statsOk = stats && !('error' in stats) ? (stats as Awaited<ReturnType<NonNullable<typeof client>['stats']>>) : null;
  return {
    generatedAt: new Date().toISOString(),
    app: { version: '0.1.0', mode: import.meta.env.MODE, native: isNative() },
    origin: { origin: location.origin, secureContext: window.isSecureContext, standalone },
    lock,
    adapter: client ? { vfs: 'opfs-sahpool', info } : { vfs: isNative() ? 'native sqlite plugin' : 'not available' },
    persist: protection,
    pool: statsOk
      ? { capacity: statsOk.capacity, fileCount: statsOk.fileCount, files: statsOk.files, openPaths: statsOk.openPaths, unavailable: statsOk.unavailable }
      : stats,
    catalogs: roles,
    packMetrics: lastPackMetrics(),
    imageCache: art,
    memory: {
      wasmMemoryBytes: statsOk?.wasmMemoryBytes ?? null,
      sqlWorkerHeapUsedBytes: statsOk?.workerHeapUsedBytes ?? null,
      sqlWorkerHeapNote: statsOk && statsOk.workerHeapUsedBytes === null ? 'not exposed by this browser for workers' : undefined,
      main: mainMemory()
    },
    measures: fdxMeasures(),
    lastStorageError: statsOk?.lastError ?? null
  };
}
