// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S7-01: after the handoff's point of no return every storage factory of the page rejects RETIRED - read-only paths and calls that were
 * already awaiting included - and the SQL client is never asked to init/open/reopen again.
 */
const calls = { init: 0, driver: 0, ensureUser: 0, openCatalogDriver: 0, importStage: 0, stats: 0, closePath: [] as string[], shutdown: 0 };
let initGate: Promise<void> = Promise.resolve();
let openGate: Promise<void> = Promise.resolve();
const closedDrivers: string[] = [];

const fakeDriver = (label: string) => ({ label, proxy: async () => ({ rows: [] }), close: async () => { closedDrivers.push(label); } });

vi.mock('./web-sqlite', () => ({
  getWebSqliteClient: () => ({
    init: async () => { calls.init += 1; await initGate; return { sessionId: 's' }; },
    driver: async () => { calls.driver += 1; await openGate; return fakeDriver('user'); }
  }),
  ensureUserDatabase: async () => { calls.ensureUser += 1; return { path: '/user/u-aaaaaa01.db', outcome: 'existing' }; }
}));
vi.mock('./web-sqlite/client', () => ({
  getWebSqliteClient: () => ({
    retire: () => undefined,
    stats: async () => { calls.stats += 1; return { openPaths: [{ path: '/user/u-aaaaaa01.db' }, { path: '/catalog-en/g-aaaaaa01.db' }] }; },
    closePath: async (path: string) => { calls.closePath.push(path); },
    shutdown: async () => { calls.shutdown += 1; }
  })
}));
vi.mock('./web-storage/role-store', () => ({ getRoleStore: () => ({}) }));
vi.mock('./web-storage/reconcile', () => ({ reconcileWebStaging: async () => undefined }));
vi.mock('./web-storage/opfs-staging', () => ({ listStagingJobs: async () => [], removeStagingJob: async () => undefined }));
vi.mock('./web-storage/runtime', () => ({ setWebRuntime: () => undefined }));
vi.mock('./pack-install', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getWebCatalogStorage: () => ({
      openCatalogDriver: async () => { calls.openCatalogDriver += 1; await openGate; return fakeDriver('catalog'); },
      releaseLanguage: async () => undefined
    })
  };
});
vi.mock('./pack-install/web-port', () => ({
  createWebInstallPort: () => ({
    stage: async () => { calls.importStage += 1; return { language: 'en' }; },
    openForValidation: async () => { calls.importStage += 1; await openGate; return fakeDriver('validate'); },
    activate: async () => 'activated',
    restorePrevious: async () => undefined,
    discardPrevious: async () => undefined,
    discardCandidate: async () => undefined,
    inspect: async () => ({}),
    remove: async () => undefined,
    capabilities: () => ({}),
    fetchManifest: async () => ''
  })
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? String(e));

async function load() {
  const mod = await import('./app-database');
  return mod;
}

beforeEach(async () => {
  vi.resetModules();
  calls.init = calls.driver = calls.ensureUser = calls.openCatalogDriver = calls.importStage = calls.stats = calls.shutdown = 0;
  calls.closePath = [];
  closedDrivers.length = 0;
  initGate = Promise.resolve();
  openGate = Promise.resolve();
});
afterEach(async () => { (await load()).__resetRetiredForTests(); });

describe('S7-01: app-database retirement fence', () => {
  it('before any boot: every factory rejects RETIRED and nothing reaches the client', async () => {
    const db = await load();
    db.fenceStorage();
    expect(await code(db.prepareStorage())).toBe('RETIRED');
    expect(await code(db.createUserDriver())).toBe('RETIRED');
    expect(await code(db.catalogSource.open('en'))).toBe('RETIRED');
    expect(await code(db.catalogSource.openWritable!('en'))).toBe('RETIRED');
    const port = db.createInstallPort();
    expect(await code(port.stage({} as never, {} as never))).toBe('RETIRED');
    expect(await code(port.openForValidation('catalog-en' as never))).toBe('RETIRED');
    expect(calls).toMatchObject({ init: 0, driver: 0, ensureUser: 0, openCatalogDriver: 0, importStage: 0 });
  });

  it('after a successful boot: the memoized prepareStorage, lazy catalog opens (read-only too) and the install port all reject RETIRED', async () => {
    const db = await load();
    await db.prepareStorage();
    const user = await db.createUserDriver();
    expect(user).toBeTruthy();
    db.fenceStorage();
    const before = { ...calls };
    expect(await code(db.prepareStorage())).toBe('RETIRED'); // cached success must not be returned
    expect(await code(db.catalogSource.open('en'))).toBe('RETIRED');
    expect(await code(db.catalogSource.openWritable!('ja'))).toBe('RETIRED');
    expect(await code(db.createUserDriver())).toBe('RETIRED');
    const port = db.createInstallPort();
    expect(await code(port.stage({} as never, {} as never))).toBe('RETIRED');
    expect(await code(port.openForValidation('catalog-en' as never))).toBe('RETIRED');
    expect(calls).toMatchObject({ init: before.init, driver: before.driver, openCatalogDriver: before.openCatalogDriver, importStage: before.importStage });
  });

  it('a createUserDriver already awaiting prepare/init: retired meanwhile -> RETIRED, no user driver opened', async () => {
    let release!: () => void;
    initGate = new Promise<void>((resolve) => { release = resolve; });
    const db = await load();
    const pending = code(db.createUserDriver());
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.init).toBe(1);
    db.fenceStorage();
    release();
    expect(await pending).toBe('RETIRED');
    expect(calls.driver).toBe(0);
  });

  it('a lazy catalog open already awaiting the driver: retired meanwhile -> the opened driver is closed and RETIRED is thrown', async () => {
    const db = await load();
    await db.prepareStorage();
    let release!: () => void;
    openGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = code(db.catalogSource.open('en'));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.openCatalogDriver).toBe(1);
    db.fenceStorage();
    release();
    expect(await pending).toBe('RETIRED');
    expect(closedDrivers).toEqual(['catalog']);
  });

  it('a stage/validation already running when the page is retired is discarded (RETIRED) and its handle closed; one retired before it starts never opens', async () => {
    const db = await load();
    await db.prepareStorage();
    const port = db.createInstallPort();
    let release!: () => void;
    openGate = new Promise<void>((resolve) => { release = resolve; });
    const running = code(port.openForValidation('catalog-en' as never));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.importStage).toBe(1);
    db.fenceStorage();
    release();
    expect(await running).toBe('RETIRED');
    expect(closedDrivers).toEqual(['validate']);
    const started = calls.importStage;
    expect(await code(port.openForValidation('catalog-en' as never))).toBe('RETIRED');
    expect(calls.importStage).toBe(started);
  });

  it('retireStorage(): fence first (synchronously), then quiesce, close every path with drain, stop the worker, release the lock - in that order', async () => {
    const db = await load();
    const order: string[] = [];
    const lock = await import('./instance-lock');
    void lock;
    const done = db.retireStorage({
      quiesce: async () => { order.push(`quiesce(retired=${db.isStorageRetired()})`); },
      step: async (promise, what) => { order.push(what); return promise; }
    });
    expect(db.isStorageRetired()).toBe(true); // raised before the first await resolved
    await done;
    expect(order).toEqual(['quiesce(retired=true)', 'Closing your collection', 'Closing your collection', 'Stopping storage']);
    expect(calls.closePath).toEqual(['/user/u-aaaaaa01.db', '/catalog-en/g-aaaaaa01.db']);
    expect(calls.shutdown).toBe(1);
  });

  it('retireStorage() keeps the lock when a close step fails (a worker may still hold handles), but the fence stays up', async () => {
    const db = await load();
    const lock = await import('./instance-lock');
    const releaseSpy = vi.spyOn(lock, 'releaseWriterLock');
    await expect(db.retireStorage({ step: async () => { throw new Error('stuck close'); } })).rejects.toThrow('stuck close');
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(db.isStorageRetired()).toBe(true);
    expect(await code(db.prepareStorage())).toBe('RETIRED');
  });

  it('S8-01 retireStorage() with an admitted job: the job fence is up at once, the job may still use storage, the page fence/close/lock wait for it to settle', async () => {
    const db = await load();
    const { jobRegistry } = await import('./web-storage/job-registry');
    const lock = await import('./instance-lock');
    const releaseSpy = vi.spyOn(lock, 'releaseWriterLock');
    await db.prepareStorage();
    const job = jobRegistry.begin('uninstall');
    const done = db.retireStorage({ jobSettleMs: 5_000 });
    expect(jobRegistry.fenced).toBe(true); // no NEW job from here on
    expect(await code(Promise.resolve().then(() => jobRegistry.begin('install')))).toBe('RETIRED');
    await sleep(40);
    expect(db.isStorageRetired()).toBe(false); // the admitted job's own storage calls must still work
    await expect(db.prepareStorage()).resolves.toBeDefined();
    expect(calls.closePath).toEqual([]);
    expect(releaseSpy).not.toHaveBeenCalled();
    job.settle();
    await done;
    expect(db.isStorageRetired()).toBe(true);
    expect(calls.closePath).toEqual(['/user/u-aaaaaa01.db', '/catalog-en/g-aaaaaa01.db']);
    expect(calls.shutdown).toBe(1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('S8-01 retireStorage() whose job never settles within the bound: BUSY, lock NOT released, nothing closed, page NOT retired', async () => {
    const db = await load();
    const { jobRegistry } = await import('./web-storage/job-registry');
    const lock = await import('./instance-lock');
    const releaseSpy = vi.spyOn(lock, 'releaseWriterLock');
    await db.prepareStorage();
    jobRegistry.begin('uninstall');
    await expect(db.retireStorage({ jobSettleMs: 30 })).rejects.toMatchObject({ code: 'BUSY' });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(calls.closePath).toEqual([]);
    expect(calls.shutdown).toBe(0);
    expect(db.isStorageRetired()).toBe(false);
  });
});
