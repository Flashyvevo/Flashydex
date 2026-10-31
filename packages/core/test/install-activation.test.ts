import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService } from '../src/services/catalog-install';
import { FakeDiskPort, KillSignal } from '../src/testing/fake-install-port';
import { createTestDatabases } from '../src/testing/node-driver';
import { harnessFor, type Harness } from './helpers';

/**
 * Stage E / N01: activation and recovery must never discard the only valid previous catalog. Covers Sol's three probes
 * (active-not-revalidated, recovery-destroys-valid-previous, web-active-put-window) + corrupt-active-with-good-previous,
 * on BOTH storage styles of the fake port (native rename, web key-write).
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

async function setup(style: 'rename' | 'web') {
  const t = await createTestDatabases();
  let h: Harness = harnessFor(t);
  cleanups.push(() => h.cleanup());
  const port = new FakeDiskPort(t.dir, t.env);
  port.style = style;
  const c = {
    get h() { return h; }, port,
    install: new CatalogInstallService(h.ctx, port, CFG),
    kill: (where: string) => () => { h.t.user.setMaintenance(true); throw new KillSignal(where); },
    async restart() {
      h = harnessFor(await h.t.reopen());
      cleanups.push(() => h.cleanup());
      port.revive();
      c.install = new CatalogInstallService(h.ctx, port, CFG);
      return c.install;
    },
    async installVersion(version: string, sha: string) {
      port.manifestJson = FakeDiskPort.manifest(['en'], version, sha);
      return c.install.install('en', noop, sig());
    },
    async receipt() {
      const r = await h.t.user.rows("SELECT status, version, sha256 FROM installed_catalogs WHERE language = 'en'");
      return { status: r[0]?.[0], version: r[0]?.[1], sha: r[0]?.[2] };
    },
    versionAt(path: string): string | null {
      if (!existsSync(path)) return null;
      const db = new Database(path, { readonly: true });
      try { return (db.prepare('SELECT version FROM catalog_meta').get() as { version: string }).version; } finally { db.close(); }
    },
    activeVersion: () => c.versionAt(port.activePath('en')),
    previousVersion: () => c.versionAt(port.previousPath('en')),
    mutate(path: string, sql: string) { const raw = new Database(path); try { raw.exec(sql); } finally { raw.close(); } }
  };
  return c;
}

describe.each(['rename', 'web'] as const)('N01 activation / recovery never discards the only valid previous (%s store)', (style) => {
  it('active-not-revalidated: an activated file that fails the cheap check BEFORE the receipt commit is rolled back; v1 receipt + file + no discard', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    c.port.calls.length = 0;
    // the activated bytes are damaged after candidate validation (storage fault between activate and commit)
    c.port.hooks[style === 'web' ? 'activate:put' : 'activate:end'] = () => c.mutate(c.port.activePath('en'), 'CREATE TABLE injected_after_validation(x TEXT)');
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'PACK_INVALID' });
    c.port.hooks = {};
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(c.activeVersion()).toBe(V1);
    expect(c.port.calls.filter((x) => x === 'discardPrevious:en')).toHaveLength(0);
    expect(await c.port.inspect('en')).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
    // still installable afterwards
    await c.installVersion(V2, HB);
    expect(await c.receipt()).toMatchObject({ version: V2 });
  });

  it('active meta mismatch at activation (language/version of the activated file != target): rolled back, previous kept', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    c.port.hooks['activate:end'] = () => c.mutate(c.port.activePath('en'), "UPDATE catalog_meta SET version = '2099.01.01.001'");
    await expect(c.install.install('en', noop, sig())).rejects.toMatchObject({ code: 'PACK_INVALID' });
    c.port.hooks = {};
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1 });
    expect(c.activeVersion()).toBe(V1);
  });

  it('recovery-destroys-valid-previous: committed v2 receipt, previous kept, active later damaged -> boot restores the VALIDATED previous and its v1 receipt', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('retain previous'); };
    await c.installVersion(V2, HB);
    c.port.hooks = {};
    expect(c.previousVersion()).toBe(V1);
    await c.h.t.databases.invalidateCatalog('en');
    c.mutate(c.port.activePath('en'), "UPDATE catalog_meta SET version = '2099.01.01.001'");
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).not.toContain('en:discarded-previous');
    expect(r.actions).toContain('en:restored-previous-invalid-active');
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1, sha: HA });
    expect(c.activeVersion()).toBe(V1);
  });

  it('corrupt-active-with-good-previous (active has an unexpected table): previous restored, never discarded', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('retain previous'); };
    await c.installVersion(V2, HB);
    c.port.hooks = {};
    await c.h.t.databases.invalidateCatalog('en');
    c.mutate(c.port.activePath('en'), 'CREATE TABLE rogue(x TEXT)');
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1 });
    expect(c.activeVersion()).toBe(V1);
    expect(await c.port.inspect('en')).toMatchObject({ activeRef: 'active:en' });
  });

  it('both active and previous invalid: receipt marked failed and the previous file is NOT discarded', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('retain previous'); };
    await c.installVersion(V2, HB);
    c.port.hooks = {};
    await c.h.t.databases.invalidateCatalog('en');
    c.mutate(c.port.activePath('en'), 'CREATE TABLE rogue(x TEXT)');
    c.mutate(c.port.previousPath('en'), 'CREATE TABLE rogue2(x TEXT)');
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'failed' });
    expect(existsSync(c.port.previousPath('en'))).toBe(true);
    expect(existsSync(c.port.activePath('en'))).toBe(true);
  });

  it('valid active + retained previous still discards the previous at boot (cleanup path unchanged)', async () => {
    const c = await setup(style);
    await c.installVersion(V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('retain previous'); };
    await c.installVersion(V2, HB);
    c.port.hooks = {};
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).toContain('en:discarded-previous');
    expect(c.activeVersion()).toBe(V2);
    expect(existsSync(c.port.previousPath('en'))).toBe(false);
  });
});

describe('N01 web key-write boundary (active put done, candidate key not yet removed)', () => {
  async function crashAfterActivePut(first = false) {
    const c = await setup('web');
    if (!first) await c.installVersion(V1, HA);
    c.port.manifestJson = FakeDiskPort.manifest(['en'], first ? V1 : V2, first ? HA : HB);
    c.port.hooks['activate:put'] = c.kill('activate:put');
    await expect(c.install.install('en', noop, sig())).rejects.toBeDefined();
    c.port.hooks = {};
    return c;
  }

  it('web-active-put-window: active=v2 + previous=v1 + candidate all exist; recovery reconciles to ONE consistent pair (active version == receipt version) and keeps a valid copy', async () => {
    const c = await crashAfterActivePut();
    c.port.revive();
    expect(c.activeVersion()).toBe(V2);
    expect(c.previousVersion()).toBe(V1);
    expect((await c.port.inspect('en')).candidateRefs).toHaveLength(1);
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions).not.toContain('en:discarded-previous');
    const receipt = await c.receipt();
    expect(receipt).toMatchObject({ status: 'installed' });
    expect(c.activeVersion()).toBe(receipt.version);
    expect(await c.port.inspect('en')).toMatchObject({ candidateRefs: [] });
    // and the catalog is installable / consistent afterwards
    await c.installVersion(V2, HB);
    expect(await c.receipt()).toMatchObject({ version: V2, sha: HB });
    expect(c.activeVersion()).toBe(V2);
  });

  it('crash after the active put with a CORRUPT active put (torn write) keeps the valid previous', async () => {
    const c = await setup('web');
    await c.installVersion(V1, HA);
    c.port.manifestJson = FakeDiskPort.manifest(['en'], V2, HB);
    c.port.hooks['activate:put'] = () => { c.mutate(c.port.activePath('en'), 'CREATE TABLE torn(x TEXT)'); c.kill('activate:put')(); };
    await expect(c.install.install('en', noop, sig())).rejects.toBeDefined();
    c.port.hooks = {};
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1 });
    expect(c.activeVersion()).toBe(V1);
  });

  it('first install killed after the active put: uncommitted active removed, nothing adopted', async () => {
    const c = await crashAfterActivePut(true);
    const svc = await c.restart();
    await svc.recover();
    expect(await c.receipt()).toMatchObject({ status: 'absent' });
    expect(await c.port.inspect('en')).toEqual({ activeRef: null, previousRef: null, candidateRefs: [] });
  });

  it('refreshed (mutable) catalogs are not compared to the baseline SHA: a refreshed active still validates against its receipt', async () => {
    const c = await setup('rename');
    await c.installVersion(V1, HA);
    c.mutate(c.port.activePath('en'), "UPDATE catalog_cards SET name = 'Refreshed Mon', name_search = 'refreshed mon' WHERE id = 'tset-001'");
    c.port.hooks.discardPrevious = () => { throw new Error('x'); };
    const svc = await c.restart();
    const r = await svc.recover();
    expect(r.actions.filter((a) => a.includes('receipt-marked-failed') || a.includes('restored-previous'))).toEqual([]);
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V1 });
  });
});

describe('N01 rollback validates the previous before swapping it in', () => {
  it('a damaged previous is refused (NO_ROLLBACK) and the active catalog + receipt are untouched', async () => {
    const c = await setup('rename');
    await c.installVersion(V1, HA);
    c.port.hooks.discardPrevious = () => { throw new Error('retain previous'); };
    await c.installVersion(V2, HB);
    c.port.hooks = {};
    c.mutate(c.port.previousPath('en'), 'CREATE TABLE rogue(x TEXT)');
    await expect(c.install.rollback('en')).rejects.toMatchObject({ code: 'NO_ROLLBACK' });
    expect(c.activeVersion()).toBe(V2);
    expect(await c.receipt()).toMatchObject({ version: V2 });
  });
});
