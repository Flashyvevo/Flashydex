import type { CatalogInstallPort, CatalogSource, SqlDriver } from '@flashydex/core';
import { Capacitor } from '@capacitor/core';
import { closeLogicalConnection, flushWebStore, openLogicalConnection, USER_DB_NAME } from './sqlite';
import { createProxyCallback } from './sqlite-proxy';
import {
  closeCatalogDb, fetchManifestText, getCatalogStorage, getWebCatalogStorage, openCatalogDb, openCatalogDbWritable, openCatalogRef, removeCatalog, stageCatalogPack,
  type CatalogLanguageCode
} from './pack-install';
import { NATIVE_CATALOG_WRITES } from './pack-install/native-store';
import { createWebInstallPort } from './pack-install/web-port';
import type { StoragePrepareProgress, StoragePrepareResult } from './web-storage/contract';
import { setWebRuntime } from './web-storage/runtime';
import { __resetPageRetiredForTests, isPageRetired, isRetiredError, retiredError, retirePage, writeGate } from './web-storage/write-gate';
import { isWriterLockReleased, releaseWriterLock } from './instance-lock';
import { registerStorageRetirement, type RetireStorageOptions } from '../lib/handoff';

const isWeb = () => Capacitor.getPlatform() === 'web';

/* ──────────────────────────────────────────────── terminal retirement (S7-01) ──────────────────────────────────────────────── */
/**
 * Set at the point of no return of an update handoff and NEVER cleared (the page reloads). Distinct from the recoverable shutdown/reopen
 * cycle: once set, every factory below (prepareStorage, createUserDriver, catalogSource.open/openWritable, the install port's stage /
 * validation) and every SQL-client entry point rejects `WebStorageError('RETIRED')` - checked before AND after each await, read-only
 * paths and queued opens included - so a retired page can never re-acquire the pool the new page legitimately owns.
 */
const isRetired = (): boolean => isPageRetired() || isWriterLockReleased();
const assertNotRetired = (): void => {
  if (isRetired()) throw retiredError();
};

/** Synchronous, idempotent: raises the page-wide fence (the SQL client and every factory below consult it). */
export function fenceStorage(): void {
  retirePage();
}
export const isStorageRetired = (): boolean => isRetired();

/** A handle opened by a call that was retired while awaiting: close it, then refuse. */
async function refuseIfRetired<T extends SqlDriver | null>(driver: T): Promise<T> {
  if (!isRetired()) return driver;
  await Promise.resolve(driver?.close()).catch(() => undefined);
  throw retiredError();
}

/**
 * Terminal retirement for the update handoff: (1) fence (synchronous, before the first await), (2) quiesce/cancel background jobs,
 * (3) close every open path with drain, (4) terminate the worker, (5) release the origin-wide writer lock. A failure before (5)
 * deliberately does NOT release the lock (a worker may still hold SAHs); the fence stays up regardless.
 */
export async function retireStorage(options: RetireStorageOptions = {}): Promise<void> {
  fenceStorage();
  await options.quiesce?.();
  const step = options.step ?? (<T,>(promise: Promise<T>) => promise);
  if (isWeb()) {
    const { getWebSqliteClient } = await import('./web-sqlite/client');
    const client = getWebSqliteClient();
    client.retire();
    for (const open of (await client.stats()).openPaths) await step(client.closePath(open.path, { drain: true }), 'Closing your collection');
    await step(client.shutdown(), 'Stopping storage');
  }
  await releaseWriterLock();
}
registerStorageRetirement(retireStorage);

/** Test seam: a real page never un-retires. */
export function __resetRetiredForTests(): void {
  __resetPageRetiredForTests();
}

/**
 * DEV-ONLY legacy mode (`localStorage['fdx:dev-legacy-jeep'] === '1'`): the old jeep USER database, catalogs disabled. It exists to seed
 * the legacy-migration e2e. `import.meta.env.DEV` makes it unreachable (and tree-shaken) in production builds.
 */
const devLegacy = (): boolean => {
  if (!import.meta.env.DEV || !isWeb()) return false;
  try {
    return localStorage.getItem('fdx:dev-legacy-jeep') === '1';
  } catch {
    return false;
  }
};

/* ──────────────────────────────────────────────── storage preparation (bootstrap facade) ──────────────────────────────────────────────── */
const listeners = new Set<(progress: StoragePrepareProgress) => void>();
let preparing: Promise<StoragePrepareResult> | null = null;

async function runPrepare(): Promise<StoragePrepareResult> {
  assertNotRetired();
  if (!isWeb()) return { kind: 'native' };
  if (devLegacy()) return { kind: 'legacy-dev' };
  const emit = (progress: StoragePrepareProgress) => { for (const listener of listeners) listener(progress); };
  // Dynamic import: native and legacy builds never load the SQL worker client.
  const [{ getWebSqliteClient, ensureUserDatabase }, { getRoleStore }, { reconcileWebStaging }, { listStagingJobs, removeStagingJob }] = await Promise.all([
    import('./web-sqlite'), import('./web-storage/role-store'), import('./web-storage/reconcile'), import('./web-storage/opfs-staging')
  ]);
  assertNotRetired();
  emit({ phase: 'starting-worker' });
  const client = getWebSqliteClient();
  const info = await client.init();
  assertNotRetired();
  emit({ phase: 'opening-pool' });
  const roles = getRoleStore();
  const user = await ensureUserDatabase({ client, roles, onProgress: emit });
  assertNotRetired();
  setWebRuntime({ client, roles });
  try {
    // Interrupted-install cleanup. Role metadata corruption already surfaced above (never reset); anything else must not block boot.
    await reconcileWebStaging({ client, roles, stagingJobs: { list: listStagingJobs, remove: removeStagingJob } });
  } catch (error) {
    if ((error as { code?: string }).code === 'METADATA_CORRUPT') throw error;
    if (isRetiredError(error)) throw error;
    console.warn('[fdx] staging reconciliation failed; retrying at the next start', error);
  }
  assertNotRetired();
  return { kind: 'web', user, info };
}

/**
 * Bootstrap calls this AFTER the writer lock is granted and BEFORE `createUserDriver()`. Memoized (one run per page; a failed run is not
 * cached, so a retry re-runs it). `createUserDriver()` and the catalog source await it themselves when bootstrap did not.
 * Once the page is retired (S7-01) it rejects RETIRED even when the memoized run already succeeded.
 */
export function prepareStorage(onProgress?: (progress: StoragePrepareProgress) => void): Promise<StoragePrepareResult> {
  if (isRetired()) return Promise.reject(retiredError());
  if (onProgress) listeners.add(onProgress);
  preparing ??= runPrepare().catch((error: unknown) => {
    preparing = null;
    throw error;
  });
  return preparing.then((result) => {
    assertNotRetired();
    return result;
  });
}

/**
 * The user DB as a core `SqlDriver`.
 *  - web: A's sahpool client, rw on the USER path the role store points at (no autosave; commit barrier + reopen are the driver's).
 *  - native: capacitor-sqlite, unchanged.
 *  - DEV legacy (`fdx:dev-legacy-jeep`): the old jeep path below, no `reopen` (R02: jeep's close would write the failed snapshot back).
 */
export async function createUserDriver(): Promise<SqlDriver> {
  assertNotRetired();
  const prepared = await prepareStorage();
  assertNotRetired();
  const driver = prepared.kind === 'web' ? await openWebUserDriver(prepared.user.path) : await openLegacyOrNativeUserDriver(prepared.kind === 'legacy-dev');
  await refuseIfRetired(driver);
  return writeGate.wrap(withDevDelay(driver)); // update-handoff gate under every service mutation: web-storage/write-gate.ts
}

async function openWebUserDriver(path: string): Promise<SqlDriver> {
  const { getWebSqliteClient } = await import('./web-sqlite');
  return getWebSqliteClient().driver(path, 'flashydex-user', { mode: 'rw', create: false, role: 'user' });
}

async function openLegacyOrNativeUserDriver(legacyWeb: boolean): Promise<SqlDriver> {
  const connection = await openLogicalConnection(USER_DB_NAME);
  const proxy = createProxyCallback(connection);
  return {
    label: USER_DB_NAME,
    proxy,
    afterCommit: legacyWeb ? () => flushWebStore(USER_DB_NAME) : undefined,
    close: () => closeLogicalConnection(USER_DB_NAME)
  };
}

/** DEV-ONLY e2e seam (`window.__flashydexTest.sqlDelayMs`): makes a restore long enough to observe. Compiled out of production builds. */
function withDevDelay(driver: SqlDriver): SqlDriver {
  if (!import.meta.env.DEV) return driver;
  // Explicit delegation: A's logical driver is a class instance, so it must not be spread.
  return {
    label: driver.label,
    proxy: async (sql, params, method) => {
      const delay = (window as unknown as { __flashydexTest?: { sqlDelayMs?: number } }).__flashydexTest?.sqlDelayMs;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return driver.proxy(sql, params, method);
    },
    afterCommit: driver.afterCommit ? () => driver.afterCommit!() : undefined,
    reopen: driver.reopen ? () => driver.reopen!() : undefined,
    close: () => driver.close()
  };
}

/* ──────────────────────────────────────────────── catalog source ──────────────────────────────────────────────── */
/** Web keeps catalog writes (direct TCGdex refresh over the shared physical connection). Native is OFF until the writable-copy design is proven on a Mac (R04). */
const catalogWrites = (): boolean => (isWeb() ? !devLegacy() : NATIVE_CATALOG_WRITES); // TODO(R04-mac): native catalogWrites switch

const gated = (driver: SqlDriver | null): SqlDriver | null => (driver ? writeGate.wrap(driver) : driver);

/** Catalog connections are SqlDrivers over the sahpool file the role store maps as ACTIVE; an absent catalog is `null`, never created. */
export const catalogSource: CatalogSource = {
  get writable() {
    return catalogWrites();
  },
  async open(language) {
    if (isWeb()) {
      if (devLegacy()) return null;
      assertNotRetired();
      await prepareStorage();
      assertNotRetired();
      const driver = await getWebCatalogStorage().openCatalogDriver(language, 'ro');
      return gated(await refuseIfRetired(driver));
    }
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
    if (isWeb()) {
      assertNotRetired();
      await prepareStorage();
      assertNotRetired();
      const driver = await getWebCatalogStorage().openCatalogDriver(language, 'rw');
      return gated(await refuseIfRetired(driver));
    }
    if ((await getCatalogStorage().activeRef(language)) === null) return null;
    const handle = await openCatalogDbWritable(language);
    return {
      label: `catalog-${language}-rw`,
      proxy: createProxyCallback(handle.connection),
      close: () => handle.close()
    };
  },
  async release(language) {
    if (isWeb()) {
      if (!devLegacy()) await getWebCatalogStorage().releaseLanguage(language);
      return;
    }
    await closeCatalogDb(language);
  }
} as CatalogSource;

/* ──────────────────────────────────────────────── install port ──────────────────────────────────────────────── */
const MANIFEST_MAX_BYTES = 256 * 1024;
const languageOf = (ref: string): CatalogLanguageCode => (/catalog-ja/.test(ref) ? 'ja' : 'en');

/**
 * CatalogInstallPort v2. Web: `createWebInstallPort` (role store + OPFS staging + sahpool import, pointer-switch activation). Native:
 * the file-rename storage of Stage D. The adapter only stages bytes and moves roles; core validates, journals and decides rollback
 * from `inspect` (disk truth, never memory).
 */
export function createInstallPort(): CatalogInstallPort {
  const fetchManifest: CatalogInstallPort['fetchManifest'] = (input, signal) => fetchManifestText({ maxBytes: Math.min(input.maxBytes, MANIFEST_MAX_BYTES) }, signal);
  if (isWeb()) {
    const port = createWebInstallPort(getWebCatalogStorage(), { allowDevUrls: import.meta.env.DEV, fetchManifest, enabled: () => !devLegacy() });
    // Catalog operations need the prepared runtime; bootstrap prepares first, but never rely on that ordering. A retired page (S7-01) refuses
    // BEFORE touching storage and, for the operations that only stage bytes or hand out a handle, again after the await (a handle is closed first).
    // Operations that move roles (activate / restore / discard / remove) are NOT rejected after the fact: their durable effect already happened.
    const ready = <A extends unknown[], R>(fn: (...args: A) => Promise<R>, afterCheck = false) => async (...args: A): Promise<R> => {
      assertNotRetired();
      await prepareStorage();
      assertNotRetired();
      const result = await fn(...args);
      if (afterCheck && isRetired()) {
        await Promise.resolve((result as { close?: () => unknown } | null)?.close?.()).catch(() => undefined);
        throw retiredError();
      }
      return result;
    };
    return {
      ...port,
      stage: ready(port.stage, true),
      openForValidation: ready(port.openForValidation, true),
      activate: ready(port.activate),
      restorePrevious: ready(port.restorePrevious),
      discardPrevious: ready(port.discardPrevious),
      discardCandidate: ready(port.discardCandidate),
      inspect: ready(port.inspect),
      remove: ready(port.remove)
    };
  }
  return {
    allowDevUrls: import.meta.env.DEV,
    capabilities() {
      const storage = getCatalogStorage();
      return { fullInstall: true, atomicActivation: storage.capabilities.atomicRename, attachReads: false, catalogWrites: catalogWrites(), reason: null };
    },
    fetchManifest,
    async stage(entry, options) {
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
    inspect: (language) => getCatalogStorage().inspect(language),
    remove: (language) => removeCatalog(language)
  };
}
