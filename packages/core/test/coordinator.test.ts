import { afterEach, describe, expect, it } from 'vitest';
import { CatalogInstallService } from '../src/services/catalog-install';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { harness, type Harness } from './helpers';

/** R10: one admission coordinator for install / uninstall / rollback / sync / restore. */
const sig = () => new AbortController().signal;
const noop = () => undefined;
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup() {
  const h = await harness();
  open.push(h);
  const port = new FakeDiskPort(h.t.dir, h.t.env);
  port.manifestJson = FakeDiskPort.manifest(['en', 'ja']);
  const svc = new CatalogInstallService(h.ctx, port, { trustedOrigins: ['https://example.test'] });
  return { h, port, svc, co: h.t.databases.coordinator };
}
const admit = (t: Awaited<ReturnType<typeof setup>>, kind: 'sync' | 'restore' | 'install' = 'sync') =>
  t.co.admit(kind, { token: t.h.t.env.ids.uuid(), now: t.h.t.env.clock.now() });

describe('R10 coordinator: one durable admission row', () => {
  it('admit writes the single row, a second admit of ANY kind fails, release deletes it', async () => {
    const t = await setup();
    const lease = await admit(t);
    expect(await t.h.t.user.rows('SELECT id, kind FROM work_admission')).toEqual([['lock', 'sync']]);
    await expect(admit(t, 'restore')).rejects.toMatchObject({ code: 'ACTIVE_SYNC' });
    await expect(admit(t, 'install')).rejects.toMatchObject({ code: 'ACTIVE_SYNC' });
    await lease.release();
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
    await (await admit(t, 'restore')).release();
  });

  it('the row is DURABLE: a second process (new coordinator on the same file) is refused until boot reconcile clears the dead owner', async () => {
    const t = await setup();
    await admit(t); // never released: the process "dies"
    const h2 = (await import('./helpers')).harnessFor(await t.h.t.reopen());
    open.push(h2);
    await expect(h2.t.databases.coordinator.admit('install', { token: 'x', now: h2.t.env.clock.now() })).rejects.toMatchObject({ code: expect.stringMatching(/^ACTIVE_/) });
    expect(await h2.t.databases.coordinator.reconcile()).toBe(true);
    await (await h2.t.databases.coordinator.admit('install', { token: 'x', now: h2.t.env.clock.now() })).release();
  });

  it('install started twice concurrently: exactly one wins, in both orders; the loser never touches the disk', async () => {
    for (const first of ['en', 'ja'] as const) {
      const t = await setup();
      let release!: () => void;
      t.port.hold = new Promise<void>((r) => { release = r; });
      const second = first === 'en' ? 'ja' : 'en';
      const a = t.svc.install(first, noop, sig());
      const b = t.svc.install(second, noop, sig());
      await expect(b).rejects.toMatchObject({ code: 'ACTIVE_WORK' });
      release();
      await expect(a).resolves.toMatchObject({ language: first, status: 'installed' });
      expect(t.port.calls.filter((c) => c.startsWith('stage'))).toEqual([`stage:${first}:2026.10.31.001`]);
    }
  });

  it('uninstall and rollback during an install are refused (ACTIVE_WORK); the install completes', async () => {
    const t = await setup();
    let release!: () => void;
    t.port.hold = new Promise<void>((r) => { release = r; });
    const running = t.svc.install('en', noop, sig());
    await new Promise((r) => setTimeout(r, 20));
    await expect(t.svc.uninstall({ language: 'ja', confirm: true })).rejects.toMatchObject({ code: 'ACTIVE_WORK' });
    await expect(t.svc.rollback('en')).rejects.toMatchObject({ code: 'ACTIVE_WORK' });
    release();
    await expect(running).resolves.toMatchObject({ status: 'installed' });
  });

  it('read/activation race: a reader asking for the catalog while the swap is in flight waits and then sees the NEW catalog, never a missing/half file', async () => {
    const t = await setup();
    await t.svc.install('en', noop, sig());
    t.port.manifestJson = FakeDiskPort.manifest(['en'], '2026.11.01.001', 'b'.repeat(64));
    let read: Promise<unknown> | null = null;
    let heldDuringSwap = false;
    t.port.hooks['activate:between'] = async () => { // active file is gone right now
      heldDuringSwap = t.h.t.databases.barrierHeld('en');
      read = t.h.catalog.getCard({ language: 'en', cardId: 'tset-001' });
      await new Promise((r) => setTimeout(r, 40));
    };
    await t.svc.install('en', noop, sig());
    expect(heldDuringSwap).toBe(true);
    expect(await read).toMatchObject({ id: 'tset-001', name: '2026.11.01.001 Alpha Mon' });
  });

  it('an install failure releases admission, and a persistence-latched user DB still releases in memory (reconcile clears the row later)', async () => {
    const t = await setup();
    t.port.stageError = Object.assign(new Error('offline'), { code: 'HTTP_FAILED' });
    await expect(t.svc.install('en', noop, sig())).rejects.toMatchObject({ code: 'HTTP_FAILED' });
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
    t.port.stageError = null;
    const lease = await admit(t, 'install');
    t.h.t.user.setMaintenance(true); // writes refused: release cannot delete the row
    await lease.release();
    t.h.t.user.setMaintenance(false);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[1]]); // stranded row
    expect(t.co.current).toBeNull(); // memory lease gone
    expect(await t.co.reconcile()).toBe(true);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
  });

  it('writes are rejected while the user DB is blocked: install admission itself fails with the blocking code', async () => {
    const t = await setup();
    t.h.t.user.setInstanceLock({ message: 'Another tab owns FlashyDex' });
    await expect(t.svc.install('en', noop, sig())).rejects.toMatchObject({ code: 'INSTANCE_LOCK' });
    await expect(t.svc.uninstall({ language: 'en', confirm: true })).rejects.toMatchObject({ code: 'INSTANCE_LOCK' });
    expect(t.port.calls).toEqual([]);
  });
});
