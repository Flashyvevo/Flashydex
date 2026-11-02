// @vitest-environment node
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService, type CatalogInstallPort } from '@flashydex/core';
import { createNodeDriver, createTestDatabases, FakeDiskPort, KillSignal, type TestDatabases } from '@flashydex/core/testing';
import { WebStorageError, type RoleStore, type WebSqliteClient } from '../web-storage/contract';
import { createMemoryStateCell, createRoleStoreFromCell } from '../web-storage/role-store';
import { reconcileWebStaging } from '../web-storage/reconcile';
import type { InstallClient, WebStoreDeps } from '../web-storage/runtime';
import type { StageDone } from '../web-storage/opfs-staging';
import { PackInstallError } from './run-worker';
import { createWebInstallPort } from './web-port';
import { createWebCatalogStorage, requiredFreeBytes, toPackInstallError } from './web-store';

/**
 * WEB-STORAGE §4 crash table, driven through the UNCHANGED core CatalogInstallService: core -> web port (this repo) -> fake A client
 * (pool paths -> real sqlite files) + the real role-store logic over an in-memory cell. A "kill" = a hook throws KillSignal; the dying
 * process is dead (every wrapper throws) so cleanup code cannot heal the simulated crash, then a NEW process (new wrappers, same World)
 * runs boot reconciliation + core recover().
 */
const V1 = '2026.10.31.001';
const V2 = '2026.11.01.001';
const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
const CFG = { trustedOrigins: ['https://example.test'] };
const noop = () => undefined;
const sig = () => new AbortController().signal;

type HookName = string;
type Hooks = Partial<Record<HookName, () => void | Promise<void>>>;

class World {
  files = new Map<string, string>(); // pool path -> real file path
  cell = createMemoryStateCell();
  roles: RoleStore = createRoleStoreFromCell(this.cell);
  stagingDirs = new Set<string>();
  staged = new Map<string, string>(); // staging job -> real candidate file
  counter = 0;
  constructor(public t: TestDatabases, readonly factory: FakeDiskPort) {}
}

class Process {
  dead = false;
  hooks: Hooks = {};
  estimate: WebStoreDeps['estimate'] = async () => undefined;
  failOpen: (path: string) => boolean = () => false;
  failCapacity = false;
  stageError: Error | null = null;
  runStageCalls = 0;
  openDrivers = new Map<string, Set<{ close(): Promise<void> }>>();
  manifestJson: unknown = null;
  readonly client: InstallClient;
  readonly roles: RoleStore;
  readonly deps: WebStoreDeps;
  readonly storage;
  readonly port: CatalogInstallPort;

  constructor(readonly world: World, readonly ids: () => string) {
    const alive = () => { if (this.dead) throw new Error('process is dead'); };
    const hook = async (name: string) => {
      const fn = this.hooks[name];
      if (!fn) return;
      try { await fn(); } catch (error) { if (error instanceof KillSignal) this.dead = true; throw error; }
    };
    const wrap = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      alive();
      await hook(`${name}:before`);
      const result = await run();
      alive();
      await hook(`${name}:after`);
      return result;
    };
    const w = world;
    this.client = {
      ensureCapacity: async (minFree) => wrap('client.ensureCapacity', async () => {
        if (this.failCapacity) throw new WebStorageError('CAPACITY', 'no slots');
        return { capacity: 16, fileCount: w.files.size + minFree };
      }),
      driver: async (path, label, options) => wrap('client.driver', async () => {
        const real = w.files.get(path);
        if (!real) throw new WebStorageError('NOT_FOUND', 'missing');
        if (this.failOpen(path)) throw new WebStorageError('SQLITE', 'injected open failure');
        const driver = createNodeDriver(real, { readonly: options.mode === 'ro', label });
        const set = this.openDrivers.get(path) ?? new Set();
        const entry = { close: async () => { set.delete(entry); await driver.close(); } };
        set.add(entry);
        this.openDrivers.set(path, set);
        return { ...driver, label, close: entry.close, proxy: driver.proxy } as never;
      }),
      closePath: async (path) => wrap('client.closePath', async () => {
        for (const entry of [...(this.openDrivers.get(path) ?? [])]) await entry.close();
      }),
      listFiles: async () => { alive(); return [...w.files.keys()]; },
      unlink: async (path) => wrap('client.unlink', async () => {
        if ((this.openDrivers.get(path)?.size ?? 0) > 0) throw new WebStorageError('BUSY', 'open');
        const real = w.files.get(path);
        if (!real) return false;
        w.files.delete(path);
        rmSync(real, { force: true });
        return true;
      }),
      importFromStaging: async (input) => wrap('client.importFromStaging', async () => {
        const source = w.staged.get(input.source.job);
        if (!source) throw new WebStorageError('NOT_FOUND', 'no staged file');
        if (w.files.has(input.target)) throw new WebStorageError('BUSY', 'exists');
        w.counter += 1;
        const real = join(w.t.dir, `pool-${w.counter}.db`);
        copyFileSync(source, real);
        w.files.set(input.target, real);
        return { bytes: input.expectedBytes, sha256: input.expectedSha256, ms: 1, maxChunkBytes: 262144 };
      })
    } as InstallClient;
    const roleNames = ['addCandidate', 'removeCandidate', 'activate', 'restorePrevious', 'clearPrevious', 'clearLanguage', 'putIntent', 'clearIntent', 'commitUser'] as const;
    const roles = { ...w.roles } as Record<string, unknown>;
    for (const name of roleNames) {
      const real = (w.roles as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
      roles[name] = (...args: unknown[]) => wrap(`roles.${name}`, () => real(...args));
    }
    for (const name of ['load', 'language', 'user', 'migration', 'listIntents'] as const) {
      const real = (w.roles as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
      roles[name] = async (...args: unknown[]) => { alive(); return real(...args); };
    }
    this.roles = roles as unknown as RoleStore;
    this.deps = {
      client: this.client,
      roles: this.roles,
      stagingJobs: {
        list: async () => [...w.stagingDirs],
        remove: async (job) => { alive(); w.stagingDirs.delete(job); w.staged.delete(job); }
      },
      estimate: (...args) => this.estimate(...args),
      newJobId: this.ids,
      now: () => w.t.env.clock.now(),
      runStage: async (options) => {
        alive();
        this.runStageCalls += 1;
        w.stagingDirs.add(options.job);
        await hook('runStage:start');
        if (this.stageError) throw this.stageError;
        const [, language, version] = /catalog-(en|ja)-([\d.]+)\.db\.zst/.exec(options.url) ?? [];
        const ref = (await w.factory.stage({ language, targetVersion: version, compressedBytes: options.expectedCompressedBytes, uncompressedBytes: options.expectedUncompressedBytes, sha256: options.expectedSha256 } as never, { trustedOrigins: [], onProgress: noop })).candidateRef;
        w.staged.set(options.job, join(w.t.dir, ref.replace(/^cand:/, '')));
        options.onProgress?.('download', options.expectedCompressedBytes, 0, 0);
        options.onProgress?.('decode', options.expectedCompressedBytes, options.expectedUncompressedBytes, 0);
        await hook('runStage:end');
        const now = performance.timeOrigin + performance.now();
        return {
          type: 'done', compressedBytes: options.expectedCompressedBytes, decodedBytes: options.expectedUncompressedBytes, sha256: options.expectedSha256, compressedSha256: '',
          windowBytes: 1, maxChunkBytes: 262144, maxInFlightObserved: 1, pendingBytesMax: 0, timestamps: { start: now - 3, downloadEnd: now - 2, decodeEnd: now - 1 }
        } satisfies StageDone;
      }
    };
    this.storage = createWebCatalogStorage(() => this.deps);
    this.port = createWebInstallPort(this.storage, {
      allowDevUrls: false,
      fetchManifest: async () => { alive(); return { text: JSON.stringify(this.manifestJson), finalUrl: 'https://example.test/manifest.json', requestedUrl: 'https://example.test/manifest.json' }; }
    });
  }
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup(options: { userFaults?: Parameters<typeof createTestDatabases>[0] extends infer O ? (O extends { userFaults?: infer F } ? F : never) : never } = {}) {
  const t = await createTestDatabases(options.userFaults ? { userFaults: options.userFaults } : {});
  const world = new World(t, new FakeDiskPort(t.dir, t.env));
  cleanups.push(() => world.t.cleanup());
  let idCounter = 0;
  const ids = () => `job${String(++idCounter).padStart(6, '0')}`;
  const ctx = {
    world,
    proc: new Process(world, ids),
    install: undefined as unknown as CatalogInstallService,
    service() {
      return new CatalogInstallService({ databases: world.t.databases, env: world.t.env } as never, ctx.proc.port, CFG);
    },
    async restart() {
      world.t = await world.t.reopen();
      cleanups.push(() => world.t.cleanup());
      ctx.proc = new Process(world, ids);
      ctx.install = ctx.service();
      return ctx.install;
    },
    /** What the app does on boot before core services: web reconciliation, then core recover(). */
    async boot() {
      const svc = await ctx.restart();
      const summary = await reconcileWebStaging({ client: ctx.proc.client as unknown as WebSqliteClient, roles: ctx.proc.roles, stagingJobs: ctx.proc.deps.stagingJobs });
      const recovered = await svc.recover();
      return { svc, summary, recovered };
    },
    async installVersion(language: 'en' | 'ja', version: string, sha: string) {
      ctx.proc.manifestJson = FakeDiskPort.manifest([language], version, sha);
      return ctx.install.install(language, noop, sig());
    },
    async receipt(language: 'en' | 'ja' = 'en') {
      const r = await world.t.user.rows('SELECT status, version, sha256 FROM installed_catalogs WHERE language = ?', [language]);
      return { status: r[0]?.[0], version: r[0]?.[1], sha: r[0]?.[2] };
    },
    async roleView(language: 'en' | 'ja' = 'en') {
      const state = await world.roles.language(language);
      return { active: state.activeRef, previous: state.previousRef, candidates: state.candidates.map((c) => c.ref), intents: (await world.roles.listIntents()).length };
    },
    versionAt(path: string | null): string | null {
      const real = path ? world.files.get(path) : undefined;
      if (!real) return null;
      const driver = createNodeDriver(real, { readonly: true });
      try { return (driver.raw.prepare('SELECT version FROM catalog_meta').get() as { version: string }).version; } finally { driver.raw.close(); }
    },
    async activeVersion(language: 'en' | 'ja' = 'en') {
      return ctx.versionAt((await world.roles.language(language)).activeRef);
    },
    kill: (where: string) => () => { world.t.user.setMaintenance(true); throw new KillSignal(where); }
  };
  ctx.install = ctx.service();
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const poolFiles = (c: Ctx) => [...c.world.files.keys()].sort();

/** Install v1, then run a v2 install that dies at `hook`. */
async function dieDuringInstall(c: Ctx, hook: HookName, options: { first?: boolean } = {}) {
  if (!options.first) await c.installVersion('en', V1, HA);
  c.proc.hooks[hook] = c.kill(hook);
  c.proc.manifestJson = FakeDiskPort.manifest(['en'], options.first ? V1 : V2, options.first ? HA : HB);
  await expect(c.install.install('en', noop, sig())).rejects.toBeDefined();
  c.proc.hooks = {};
}

describe('web install port: happy paths and bookkeeping', () => {
  it('first install: active pool ref, no previous/candidate/intent, one file, staging removed, receipt installed', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const view = await c.roleView();
    expect(view.active).toMatch(/^\/catalog-en\/g-[a-z0-9-]{6,64}\.db$/);
    expect(view).toMatchObject({ previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toEqual([view.active]);
    expect(c.world.stagingDirs.size).toBe(0);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(await c.activeVersion()).toBe(V1);
  });

  it('update: v2 becomes active, previous generation is discarded and unlinked only after the receipt commit', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const first = (await c.roleView()).active;
    await c.installVersion('en', V2, HB);
    const view = await c.roleView();
    expect(view.active).not.toBe(first);
    expect(view.previous).toBeNull();
    expect(poolFiles(c)).toEqual([view.active]);
    expect(await c.activeVersion()).toBe(V2);
  });

  it('second install keeps previous until commit, and rollback restores it (discardPrevious failure keeps evidence)', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const first = (await c.roleView()).active;
    c.proc.hooks['roles.clearPrevious:before'] = () => { throw new Error('cleanup failed'); }; // never fails a committed install
    await c.installVersion('en', V2, HB);
    c.proc.hooks = {};
    const afterInstall = await c.roleView();
    expect(afterInstall.previous).toBe(first);
    expect(poolFiles(c)).toHaveLength(2);
    expect((await c.install.rollback('en')).version).toBe(V1);
    expect((await c.roleView()).active).toBe(first);
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(poolFiles(c)).toEqual([first]);
  });

  it('uninstall clears roles and unlinks every referenced closed file', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    await c.install.uninstall({ language: 'en', confirm: true });
    expect(await c.roleView()).toEqual({ active: null, previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toEqual([]);
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
  });

  it('capabilities: pointer activation proven, never atomicRename, no attach reads, writes + full install on', async () => {
    const c = await setup();
    expect(c.proc.port.capabilities()).toEqual({ fullInstall: true, atomicActivation: true, attachReads: false, catalogWrites: true, reason: null });
    expect(c.proc.storage.capabilities.atomicRename).toBe(false);
    expect(createWebInstallPort(c.proc.storage, { allowDevUrls: false, fetchManifest: c.proc.port.fetchManifest, enabled: () => false }).capabilities()).toMatchObject({ fullInstall: false, catalogWrites: false });
  });

  it('discardCandidate with a stale PROMOTED ref never unlinks active or previous', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    c.proc.hooks['roles.clearPrevious:before'] = () => { throw new Error('keep previous'); };
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    // drive stage + activate by hand so we hold the stale candidate ref core would still hold after an uncertain COMMIT
    const entry = { ...(FakeDiskPort.manifest(['en'], V2, HB).languages as Record<string, object>).en, language: 'en' as const } as never;
    const staged = await c.proc.port.stage(entry, { trustedOrigins: CFG.trustedOrigins, onProgress: noop });
    const activated = await c.proc.port.activate('en', staged.candidateRef);
    expect(activated.activeRef).toBe(staged.candidateRef);
    const before = poolFiles(c);
    await c.proc.port.discardCandidate(staged.candidateRef); // stale promoted ref
    await c.proc.port.discardCandidate(activated.previousRef as string); // promoted-then-previous ref
    expect(poolFiles(c)).toEqual(before);
    expect(await c.roleView()).toMatchObject({ active: staged.candidateRef, previous: activated.previousRef });
  });

  it('inspect reports mapped refs only when the pool file exists (disk truth, not role truth)', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const ref = (await c.roleView()).active as string;
    expect(await c.proc.port.inspect('en')).toEqual({ activeRef: ref, previousRef: null, candidateRefs: [] });
    c.world.files.delete(ref);
    expect(await c.proc.port.inspect('en')).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
  });
});

describe('web install port: faults before commit leave the previous catalog (or no catalog) untouched', () => {
  it('first-install failure returns to an ABSENT catalog: no roles, files, intent or staging', async () => {
    const c = await setup();
    c.proc.stageError = new PackInstallError('HTTP_FAILED', 'HTTP 500');
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'HTTP_FAILED' });
    expect(await c.roleView()).toEqual({ active: null, previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toEqual([]);
    expect(c.world.stagingDirs.size).toBe(0);
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
  });

  it('quota / short-write / hash / size style stage failures map to core codes and keep the previous catalog searchable', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const active = (await c.roleView()).active;
    for (const [adapterCode, coreCode] of [['STORAGE_FULL', 'STORAGE_FULL'], ['PACK_HASH_MISMATCH', 'PACK_HASH_MISMATCH'], ['PACK_SIZE_MISMATCH', 'PACK_SIZE_MISMATCH'], ['ACTIVATION_FAILED', 'PACK_INVALID']] as const) {
      c.proc.stageError = new PackInstallError(adapterCode, 'injected');
      c.proc.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
      await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: coreCode });
      expect(await c.roleView()).toEqual({ active, previous: null, candidates: [], intents: 0 });
      expect(poolFiles(c)).toEqual([active]);
      expect(c.world.stagingDirs.size).toBe(0);
      expect(await c.activeVersion()).toBe(V1);
    }
  });

  it('pool capacity exhaustion maps to STORAGE_FULL before any allocation (no intent, no staging)', async () => {
    const c = await setup();
    c.proc.failCapacity = true;
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(c.proc.runStageCalls).toBe(0);
    expect((await c.roleView()).intents).toBe(0);
  });

  it('disk preflight = compressed + 2x raw + max(32 MiB, 10% raw); insufficient free space fails before the intent is written', async () => {
    expect(requiredFreeBytes(12_343_679, 138_002_432)).toBe(12_343_679 + 2 * 138_002_432 + 32 * 1024 * 1024);
    expect(requiredFreeBytes(1000, 1_000_000_000)).toBe(1000 + 2_000_000_000 + 100_000_000); // 10% wins on a big pack
    const c = await setup();
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    const need = requiredFreeBytes(1000, 5000);
    c.proc.estimate = async () => ({ quota: 1_000_000_000, usage: 1_000_000_000 - (need - 1) });
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(c.proc.runStageCalls).toBe(0);
    expect((await c.roleView()).intents).toBe(0);
    c.proc.estimate = async () => ({ quota: 1_000_000_000, usage: 1_000_000_000 - need });
    await c.install.install('en', noop, sig());
    expect(await c.receipt()).toMatchObject({ status: 'installed' });
  });

  it('cancellation maps to CANCELLED and leaves no candidate', async () => {
    const c = await setup();
    c.proc.stageError = new PackInstallError('CANCELLED', 'cancelled');
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(poolFiles(c)).toEqual([]);
  });

  it('error mapping covers the web vocabulary', () => {
    expect(toPackInstallError(new WebStorageError('QUOTA', 'q')).code).toBe('STORAGE_FULL');
    expect(toPackInstallError(new WebStorageError('INTEGRITY', 'hash differs')).code).toBe('PACK_HASH_MISMATCH');
    expect(toPackInstallError(new WebStorageError('INTEGRITY', 'byte count differs')).code).toBe('PACK_SIZE_MISMATCH');
    expect(toPackInstallError(new WebStorageError('CANCELLED', 'c')).code).toBe('CANCELLED');
    expect(toPackInstallError(new WebStorageError('IO', 'io')).code).toBe('ACTIVATION_FAILED');
  });
});

describe('WEB-STORAGE §4 crash table through core CatalogInstallService', () => {
  it('row 1: killed mid transfer/decode -> old active stays, intent + staging reconciled, job interrupted', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'runStage:end');
    expect((await c.roleView()).intents).toBe(1);
    expect(c.world.stagingDirs.size).toBe(1);
    const { summary, recovered } = await c.boot();
    expect(summary.clearedIntents).toHaveLength(1);
    expect(c.world.stagingDirs.size).toBe(0);
    expect(recovered.interruptedJobs).toBe(1);
    expect(await c.receipt()).toMatchObject({ version: V1, sha: HA });
    expect(await c.activeVersion()).toBe(V1);
    expect(poolFiles(c)).toHaveLength(1);
  });

  it('row 1b: killed after the pool import but before candidate registration -> orphan generation unlinked, active untouched', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'client.importFromStaging:after');
    expect(poolFiles(c)).toHaveLength(2);
    const active = (await c.roleView()).active;
    const { summary } = await c.boot();
    expect(summary.unlinkedFiles).toHaveLength(1);
    expect(poolFiles(c)).toEqual([active]);
    expect(await c.activeVersion()).toBe(V1);
    expect((await c.roleView()).intents).toBe(0);
  });

  it('row 1c: killed after registration (candidate + intent present) -> candidate discarded by core recovery, active untouched', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'roles.addCandidate:after');
    expect((await c.roleView()).candidates).toHaveLength(1);
    const active = (await c.roleView()).active;
    const { summary } = await c.boot();
    expect(summary.unlinkedFiles).toEqual([]); // referenced by the candidate role: reconciliation must not touch it
    expect(poolFiles(c)).toEqual([active]); // core's recover() discarded the candidate through the port
    expect((await c.roleView()).candidates).toEqual([]);
    expect(await c.receipt()).toMatchObject({ version: V1 });
  });

  it('row 2: PREPARED journal, pointer transaction not committed -> membership and active unchanged, candidate discarded', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'roles.activate:before');
    expect(await c.world.t.user.rows("SELECT state FROM catalog_install_jobs ORDER BY created_at DESC LIMIT 1")).toEqual([['prepared']]);
    const active = (await c.roleView()).active;
    await c.boot();
    expect(await c.activeVersion()).toBe(V1);
    expect(await c.roleView()).toEqual({ active, previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toEqual([active]);
    expect(await c.receipt()).toMatchObject({ version: V1 });
  });

  it('row 3: pointer committed, no new receipt -> previous restored, new generation removed, v1 receipt kept', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'roles.activate:after');
    expect(await c.activeVersion()).toBe(V2);
    expect((await c.roleView()).previous).not.toBeNull();
    const { recovered } = await c.boot();
    expect(recovered.reconciled).toContain('en');
    expect(await c.activeVersion()).toBe(V1);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(await c.roleView()).toMatchObject({ previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toHaveLength(1);
    await c.installVersion('en', V2, HB); // the app can install v2 again afterwards
    expect(await c.receipt()).toMatchObject({ version: V2 });
  });

  it('row 3 (first install): pointer committed, no receipt -> back to NO catalog, never an empty fabricated DB', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'roles.activate:after', { first: true });
    expect((await c.roleView()).active).not.toBeNull();
    await c.boot();
    expect(await c.roleView()).toEqual({ active: null, previous: null, candidates: [], intents: 0 });
    expect(poolFiles(c)).toEqual([]);
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
  });

  async function commitUncertain(persisted: 'post' | 'pre') {
    let fail = false;
    let snapshot: string | null = null;
    let dir = '';
    const c = await setup({
      userFaults: {
        afterCommit: async () => { if (fail) { fail = false; throw new Error('IndexedDB quota'); } },
        beforeReopen: () => { if (persisted === 'pre' && snapshot) copyFileSync(snapshot, join(dir, 'flashydex-user.db')); }
      }
    });
    dir = c.world.t.dir;
    await c.installVersion('en', V1, HA);
    snapshot = join(dir, 'snapshot-user.db');
    c.proc.hooks['roles.activate:after'] = () => { copyFileSync(join(dir, 'flashydex-user.db'), snapshot as string); fail = true; };
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    c.proc.hooks = {};
    return c;
  }

  it('row 4: receipt COMMIT uncertain (persisted = post-commit) -> BOTH generations retained until the receipt is re-read, then previous discarded', async () => {
    const c = await commitUncertain('post');
    const view = await c.roleView();
    expect(view.active).not.toBeNull();
    expect(view.previous).not.toBeNull();
    expect(poolFiles(c)).toHaveLength(2); // core's error cleanup (stale discardCandidate) did not unlink either
    await c.world.t.user.recover();
    const { svc } = await c.boot();
    void svc;
    expect(await c.activeVersion()).toBe(V2);
    expect(await c.receipt()).toMatchObject({ version: V2 });
    expect(await c.roleView()).toMatchObject({ previous: null, candidates: [] });
    expect(poolFiles(c)).toHaveLength(1);
  });

  it('row 4b: receipt COMMIT uncertain (persisted = pre-commit) -> boot recovery sees PREPARED and restores v1', async () => {
    const c = await commitUncertain('pre');
    expect(poolFiles(c)).toHaveLength(2);
    await c.world.t.user.recover();
    await c.boot();
    expect(await c.activeVersion()).toBe(V1);
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(await c.roleView()).toMatchObject({ previous: null, candidates: [] });
    expect(poolFiles(c)).toHaveLength(1);
  });

  it('row 5: receipt committed, cleanup interrupted -> active validated, previous discarded at boot', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'roles.clearPrevious:before');
    expect(await c.receipt()).toMatchObject({ version: V2 });
    expect((await c.roleView()).previous).not.toBeNull();
    const { recovered } = await c.boot();
    expect(recovered.actions).toContain('en:discarded-previous');
    expect(await c.activeVersion()).toBe(V2);
    expect(await c.roleView()).toMatchObject({ previous: null });
    expect(poolFiles(c)).toHaveLength(1);
  });

  it('row 6: the new active fails its final validation while previous is valid -> previous restored, old receipt kept, new generation removed', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const first = (await c.roleView()).active as string;
    // the activated file refuses to open for the post-activation check only
    c.proc.hooks['roles.activate:after'] = () => { c.proc.failOpen = (path) => path !== first; };
    c.proc.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'PACK_INVALID' });
    c.proc.hooks = {};
    c.proc.failOpen = () => false;
    expect(await c.roleView()).toEqual({ active: first, previous: null, candidates: [], intents: 0 });
    expect(await c.receipt()).toMatchObject({ version: V1, sha: HA });
    expect(await c.activeVersion()).toBe(V1);
    expect(poolFiles(c)).toEqual([first]);
  });
});

describe('boot reconciliation never touches USER or referenced refs', () => {
  const user = '/user/u-abcdef.db';
  it('keeps /user/*, referenced active/previous/candidates and user-target intents; removes proven orphans only', async () => {
    const c = await setup();
    const w = c.world;
    for (const path of [user, '/catalog-en/g-active1.db', '/catalog-en/g-prev001.db', '/catalog-en/g-cand001.db', '/catalog-en/g-orphan1.db', '/catalog-ja/g-orphan2.db', '/catalog-en/g-intent1.db']) w.files.set(path, join(w.t.dir, `fake-${path.replaceAll('/', '_')}`));
    await w.roles.commitUser({ path: user, origin: 'fresh', createdAt: 'now' }, null);
    const base = { sha256: 'a'.repeat(64), bytes: 1, createdAt: 'now' };
    await w.roles.addCandidate('en', { ref: '/catalog-en/g-prev001.db', job: 'p', version: 'v', ...base });
    await w.roles.activate('en', '/catalog-en/g-prev001.db', null);
    await w.roles.addCandidate('en', { ref: '/catalog-en/g-active1.db', job: 'a', version: 'v', ...base });
    await w.roles.activate('en', '/catalog-en/g-active1.db', '/catalog-en/g-prev001.db');
    await w.roles.addCandidate('en', { ref: '/catalog-en/g-cand001.db', job: 'c', version: 'v', ...base });
    await w.roles.putIntent({ job: 'migr0001', target: 'user', targetRef: user, stagingJob: null, startedAt: 'now' });
    await w.roles.putIntent({ job: 'intent01', target: 'en', targetRef: '/catalog-en/g-intent1.db', stagingJob: 'intent01', startedAt: 'now' });
    w.stagingDirs.add('intent01');
    w.stagingDirs.add('strayjob1');
    const summary = await reconcileWebStaging({ client: c.proc.client as unknown as WebSqliteClient, roles: c.proc.roles, stagingJobs: c.proc.deps.stagingJobs });
    expect([...w.files.keys()].sort()).toEqual([user, '/catalog-en/g-active1.db', '/catalog-en/g-cand001.db', '/catalog-en/g-prev001.db'].sort());
    expect(summary.unlinkedFiles.sort()).toEqual(['/catalog-en/g-intent1.db', '/catalog-en/g-orphan1.db', '/catalog-ja/g-orphan2.db']);
    expect([...w.stagingDirs]).toEqual([]);
    expect((await w.roles.listIntents()).map((i) => i.job)).toEqual(['migr0001']);
  });

  it('corrupt role metadata propagates and nothing is swept', async () => {
    const c = await setup();
    c.world.files.set('/catalog-en/g-orphan1.db', join(c.world.t.dir, 'x'));
    c.world.cell = createMemoryStateCell({ schema: 9 });
    c.world.roles = createRoleStoreFromCell(c.world.cell);
    const proc = new Process(c.world, () => 'job000001');
    await expect(reconcileWebStaging({ client: proc.client as unknown as WebSqliteClient, roles: proc.roles, stagingJobs: proc.deps.stagingJobs })).rejects.toMatchObject({ code: 'METADATA_CORRUPT' });
    expect(c.world.files.has('/catalog-en/g-orphan1.db')).toBe(true);
  });
});
