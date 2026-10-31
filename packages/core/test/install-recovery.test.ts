import Database from 'better-sqlite3';
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService } from '../src/services/catalog-install';
import { FakeDiskPort, KillSignal, type FakePortHook } from '../src/testing/fake-install-port';
import { createTestDatabases, type NodeDriverFaults } from '../src/testing/node-driver';
import { harnessFor, type Harness } from './helpers';

/**
 * R06: every rename / commit / reopen / rollback boundary. A "kill" = a fault hook throws KillSignal; the port is then dead and the
 * user DB refuses writes (so the dying process cannot heal itself), then a NEW service over the SAME sqlite files + SAME disk state
 * runs recover().
 */
const V1 = '2026.10.31.001';
const V2 = '2026.11.01.001';
const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
const CFG = { trustedOrigins: ['https://example.test'] };
const noop = () => undefined;
const sig = () => new AbortController().signal;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});

async function setup(options: { userFaults?: NodeDriverFaults } = {}) {
  const t = await createTestDatabases(options.userFaults ? { userFaults: options.userFaults } : {});
  let h: Harness = harnessFor(t);
  cleanups.push(() => h.cleanup());
  const port = new FakeDiskPort(t.dir, t.env);
  const svc = () => new CatalogInstallService(h.ctx, port, CFG);
  const ctx = {
    get h() { return h; }, port,
    install: svc(),
    kill: (where: string) => () => { h.t.user.setMaintenance(true); throw new KillSignal(where); },
    async restart() {
      const t2 = await h.t.reopen();
      h = harnessFor(t2);
      cleanups.push(() => h.cleanup());
      port.revive();
      ctx.install = svc();
      return ctx.install;
    },
    async installVersion(language: 'en' | 'ja', version: string, sha: string) {
      port.manifestJson = FakeDiskPort.manifest([language], version, sha);
      return ctx.install.install(language, noop, sig());
    },
    async receipt(language: 'en' | 'ja' = 'en') {
      const r = await h.t.user.rows('SELECT status, version, sha256, generation FROM installed_catalogs WHERE language = ?', [language]);
      return { status: r[0]?.[0], version: r[0]?.[1], sha: r[0]?.[2], generation: Number(r[0]?.[3]) };
    },
    activeVersion(language: 'en' | 'ja' = 'en'): string | null {
      const path = port.activePath(language);
      if (!existsSync(path)) return null;
      const db = new Database(path, { readonly: true });
      try { return (db.prepare('SELECT version FROM catalog_meta').get() as { version: string }).version; } finally { db.close(); }
    },
    disk: async (language: 'en' | 'ja' = 'en') => { const d = port.dead; port.dead = false; try { return await port.inspect(language); } finally { port.dead = d; } }
  };
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Run an update install that dies at `hook`. */
async function dieDuringInstall(c: Ctx, hook: FakePortHook, options: { first?: boolean } = {}) {
  if (!options.first) await c.installVersion('en', V1, HA);
  c.port.hooks[hook] = c.kill(hook);
  c.port.manifestJson = FakeDiskPort.manifest(['en'], options.first ? V1 : V2, options.first ? HA : HB);
  await expect(c.install.install('en', noop, sig())).rejects.toBeDefined();
  c.port.hooks = {};
}

describe('R06 install recovery: update (old catalog v1 installed, v2 install killed)', () => {
  it('crash before the prepared journal (during stage): old receipt+file kept, job interrupted, candidate discarded', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'stage:end');
    expect((await c.disk()).candidateRefs).toHaveLength(1);
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.interruptedJobs).toBe(1);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    expect(await c.h.t.user.rows("SELECT state, lock_key FROM catalog_install_jobs ORDER BY created_at DESC LIMIT 1")).toEqual([['interrupted', null]]);
    expect((await svc.status('en')).installed).toMatchObject({ version: V1 });
  });

  it('crash after the journal, before activate: nothing renamed; candidate removed; old receipt kept', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'activate:start');
    expect(await c.h.t.user.rows("SELECT state FROM catalog_install_jobs ORDER BY created_at DESC LIMIT 1")).toEqual([['prepared']]);
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });

  it('crash BETWEEN the two renames (no active file, previous + candidate on disk): previous restored, candidate removed', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'activate:between');
    expect(await c.disk()).toMatchObject({ activeRef: null, previousRef: 'previous:en' });
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });

  it('crash after activate, before the receipt commit (active = v2 bytes, receipt = v1): previous restored, v1 receipt kept', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'activate:end');
    expect(c.activeVersion()).toBe(V2);
    expect((await c.receipt()).version).toBe(V1);
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.reconciled).toContain('en');
    expect(c.activeVersion()).toBe(V1);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    // the app can install v2 again afterwards
    await c.installVersion('en', V2, HB);
    expect(await c.receipt()).toMatchObject({ version: V2 });
  });

  it('crash after the receipt commit, before discardPrevious: v2 stays, previous discarded at boot', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'discardPrevious');
    expect(await c.receipt()).toMatchObject({ version: V2 });
    expect(await c.disk()).toMatchObject({ previousRef: 'previous:en' });
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).toContain('en:discarded-previous');
    expect(c.activeVersion()).toBe(V2);
    expect(await c.receipt()).toMatchObject({ version: V2, sha: HB });
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    expect((await svc.status('en')).rollbackAvailable).toBe(false);
  });

  it('crash DURING rollback after the file swap but before the receipt: receipt completed from the journal', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('cleanup failed'); };
    await c.installVersion('en', V2, HB);
    c.port.hooks = {};
    c.port.hooks['restore:end'] = c.kill('restore:end');
    await expect(c.install.rollback('en')).rejects.toBeDefined();
    c.port.hooks = {};
    expect(c.activeVersion()).toBe(V1);
    expect((await c.receipt()).version).toBe(V2); // inconsistent on purpose
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).toContain('en:rollback-completed');
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(c.activeVersion()).toBe(V1);
  });

  it('crash during rollback BEFORE the file swap: rollback abandoned, v2 stays, previous discarded', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('cleanup failed'); };
    await c.installVersion('en', V2, HB);
    c.port.hooks = { 'restore:start': c.kill('restore:start') };
    await expect(c.install.rollback('en')).rejects.toBeDefined();
    c.port.hooks = {};
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).toContain('en:rollback-abandoned');
    expect(c.activeVersion()).toBe(V2);
    expect(await c.receipt()).toMatchObject({ version: V2 });
    expect(await c.disk()).toMatchObject({ previousRef: null });
  });

  it('previous on disk + installed receipt + NO active file: previous becomes active again', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const { renameSync } = await import('node:fs');
    renameSync(c.port.activePath('en'), c.port.previousPath('en'));
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).toContain('en:restored-previous-as-active');
    expect(c.activeVersion()).toBe(V1);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1 });
  });

  it('active file whose catalog_meta no longer matches the receipt: receipt marked failed, file kept (no full rehash)', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    const raw = new Database(c.port.activePath('en'));
    raw.prepare("UPDATE catalog_meta SET version = '2099.01.01.001'").run();
    raw.close();
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'failed', version: V1 });
    expect(existsSync(c.port.activePath('en'))).toBe(true);
  });

  it('committed receipt whose sha disagrees with the committed install job: marked failed', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    await c.h.t.user.run("UPDATE installed_catalogs SET sha256 = ? WHERE language = 'en'", ['c'.repeat(64)]);
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'failed' });
  });
});

describe('R06 install recovery: first install (no old receipt)', () => {
  it('crash between the renames: candidate removed, receipt stays absent, no empty catalog created', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'activate:between', { first: true });
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
    expect(await c.disk()).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
  });

  it('crash after activate, before the receipt commit: the uncommitted active file is REMOVED (not adopted)', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'activate:end', { first: true });
    expect(c.activeVersion()).toBe(V1);
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
    expect(await c.disk()).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
  });

  it('crash before the journal (stage): nothing active, candidate removed', async () => {
    const c = await setup();
    await dieDuringInstall(c, 'stage:end', { first: true });
    const svc = await c.restart();
    await svc.recover();
    expect(await c.disk()).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
  });
});

describe('R06 disk full / activation failure (no crash)', () => {
  const full = () => Object.assign(new Error('no space'), { code: 'STORAGE_FULL' });

  it('update: activate throws STORAGE_FULL before any rename -> old catalog + receipt intact, candidate gone, job failed', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    c.port.activateError = full();
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    expect(await c.h.t.user.rows("SELECT state, lock_key FROM catalog_install_jobs ORDER BY created_at DESC LIMIT 1")).toEqual([['failed', null]]);
    expect((await c.h.collection.list({ groupBy: 'copy' })).data).toEqual([]);
  });

  it('update: STORAGE_FULL between the renames -> previous restored in-process', async () => {
    const c = await setup();
    await c.installVersion('en', V1, HA);
    c.port.activateError = full();
    c.port.activateErrorAt = 'between';
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    expect(await c.receipt()).toMatchObject({ version: V1 });
  });

  it('first install: STORAGE_FULL -> nothing active, receipt absent', async () => {
    const c = await setup();
    c.port.activateError = full();
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V1, HA);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(await c.disk()).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
  });
});

describe('R06 + R02: persistence failure on the receipt commit', () => {
  async function scenario(persisted: 'post' | 'pre') {
    let fail = false;
    let snapshot: string | null = null;
    let dir = '';
    const c = await setup({
      userFaults: {
        afterCommit: async () => { if (fail) { fail = false; throw new Error('IndexedDB quota'); } },
        beforeReopen: () => { if (persisted === 'pre' && snapshot) copyFileSync(snapshot, join(dir, 'flashydex-user.db')); }
      }
    });
    dir = c.h.t.dir;
    await c.installVersion('en', V1, HA);
    snapshot = join(dir, 'snapshot-user.db');
    // Snapshot = durable state right after the PREPARED journal (what a lost flush would leave behind).
    c.port.hooks['activate:end'] = () => { copyFileSync(join(dir, 'flashydex-user.db'), snapshot as string); fail = true; };
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    c.port.hooks = {};
    expect(c.h.t.user.status()).toMatchObject({ writable: false, reason: 'persistence_failed' });
    return c;
  }

  it('persisted state = POST-commit: files are left alone; recover() + boot recovery discard the previous copy', async () => {
    const c = await scenario('post');
    await c.h.t.user.recover();
    expect(c.h.t.user.status().writable).toBe(true);
    expect(await c.receipt()).toMatchObject({ version: V2 });
    const svc = await c.restart();
    await svc.recover();
    expect(c.activeVersion()).toBe(V2);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });

  it('persisted state = PRE-commit: boot recovery sees the prepared journal and rolls the files back to v1', async () => {
    const c = await scenario('pre');
    await c.h.t.user.recover();
    expect(await c.receipt()).toMatchObject({ version: V1 }); // reopen returned the PRE-commit state
    const svc = await c.restart();
    await svc.recover();
    expect(c.activeVersion()).toBe(V1);
    expect(await c.receipt()).toMatchObject({ version: V1 });
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });
});
