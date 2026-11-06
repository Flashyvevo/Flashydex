import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService } from '../src/services/catalog-install';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { createTestDatabases } from '../src/testing/node-driver';
import { harnessFor, type Harness } from './helpers';

/**
 * S5-01: the receipt transaction's COMMIT rejects with commitState 'unknown' (worker death / IO / lost ack). The install must behave like a
 * failing afterCommit: PERSISTENCE_FAILED, BOTH generations and the receipt retained, no ROLLBACK, no undoSwap/restorePrevious.
 */
const V1 = '2026.10.31.001';
const V2 = '2026.11.01.001';
const HA = 'a'.repeat(64);
const HB = 'b'.repeat(64);
const CFG = { trustedOrigins: ['https://example.test'] };
const noop = () => undefined;
const sig = () => new AbortController().signal;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups) await c(); cleanups = []; });

async function scenario(applied: boolean) {
  const t = await createTestDatabases();
  let h: Harness = harnessFor(t);
  cleanups.push(() => h.cleanup());
  const port = new FakeDiskPort(t.dir, t.env);
  const svc = () => new CatalogInstallService(h.ctx, port, CFG);
  const install = (version: string, sha: string) => { port.manifestJson = FakeDiskPort.manifest(['en'], version, sha); return svc().install('en', noop, sig()); };
  const receipt = async () => { const r = await h.t.user.rows('SELECT status, version FROM installed_catalogs WHERE language = ?', ['en']); return { status: r[0]?.[0], version: r[0]?.[1] }; };
  const activeVersion = (): string | null => {
    if (!existsSync(port.activePath('en'))) return null;
    const db = new Database(port.activePath('en'), { readonly: true });
    try { return (db.prepare('SELECT version FROM catalog_meta').get() as { version: string }).version; } finally { db.close(); }
  };
  const disk = async () => port.inspect('en');

  await install(V1, HA);
  // Instrument the user connection: arm at `activate:end`; the NEXT COMMIT is the receipt transaction.
  const raw = (h.t.user.driver as unknown as { raw: Database.Database }).raw;
  const prepare = raw.prepare.bind(raw) as (sql: string) => { run: (...a: unknown[]) => unknown };
  let armed = false;
  let rollbacks = 0;
  (raw as unknown as { prepare: unknown }).prepare = (sql: string) => {
    const statement = prepare(sql);
    if (sql === 'ROLLBACK') rollbacks += 1;
    if (armed && sql === 'COMMIT') {
      armed = false;
      return { ...statement, run: () => { if (applied) statement.run(); throw Object.assign(new Error('IO: commit acknowledgement lost'), { commitState: 'unknown' }); } };
    }
    return statement;
  };
  port.hooks['activate:end'] = () => { armed = true; };
  await expect(install(V2, HB)).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  port.hooks = {};
  return {
    user: h.t.user, receipt, activeVersion, disk, rollbacks: () => rollbacks,
    async restartAndRecover() {
      h = harnessFor(await h.t.reopen());
      cleanups.push(() => h.cleanup());
      port.revive();
      await new CatalogInstallService(h.ctx, port, CFG).recover();
    }
  };
}

describe('S5-01: receipt COMMIT with unknown outcome', () => {
  it('lost ack, COMMIT durable: keeps BOTH generations + receipt, latches, no ROLLBACK, no undoSwap; recover() then boot cleanup finish cleanly', async () => {
    const c = await scenario(true);
    expect(c.user.status()).toMatchObject({ writable: false, reason: 'persistence_failed' });
    expect(c.rollbacks()).toBe(0);
    const disk = await c.disk();
    expect(disk.activeRef).toBe('active:en');
    expect(disk.previousRef).not.toBeNull(); // previous generation retained
    expect(c.activeVersion()).toBe(V2); // the new catalog was not unlinked / restored away
    await c.user.recover();
    expect(await c.receipt()).toMatchObject({ status: 'installed', version: V2 });
    await c.restartAndRecover();
    expect(c.activeVersion()).toBe(V2);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });

  it('COMMIT never applied: files untouched until recover(); reopen shows the old receipt; boot recovery restores v1', async () => {
    const c = await scenario(false);
    expect(c.rollbacks()).toBe(0);
    expect(c.activeVersion()).toBe(V2);
    expect((await c.disk()).previousRef).not.toBeNull();
    await c.user.recover();
    expect(await c.receipt()).toMatchObject({ version: V1 });
    await c.restartAndRecover();
    expect(c.activeVersion()).toBe(V1);
    expect(await c.disk()).toEqual({ activeRef: 'active:en', previousRef: null, candidateRefs: [] });
  });
});
