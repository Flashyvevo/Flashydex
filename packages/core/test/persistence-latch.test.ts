import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageService, type StorageStatus } from '../src/services/storage';
import { TransferService } from '../src/transfer/service';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { createTestDatabases, type NodeDriverFaults } from '../src/testing/node-driver';
import { copyOf, harness, harnessFor, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** R02 / D43: fail-closed persistence latch. COMMIT happened, the flush failed: block every write until storage.recover(). */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

type Control = { failNext: boolean; snapshotTo: string | null; restoreFrom: string | null };
async function setup() {
  const control: Control = { failNext: false, snapshotTo: null, restoreFrom: null };
  let dir = '';
  const faults: NodeDriverFaults = {
    afterCommit: async () => {
      if (control.failNext) { control.failNext = false; throw new Error('IndexedDB quota exceeded'); }
    },
    beforeReopen: () => { if (control.restoreFrom) copyFileSync(control.restoreFrom, join(dir, 'flashydex-user.db')); }
  };
  const t = await createTestDatabases({ userFaults: faults });
  dir = t.dir;
  const h = harnessFor(t);
  open.push(h);
  await installStandardCatalog(h);
  const storage = new StorageService(t.databases);
  return { h, storage, control, snapshot: () => { control.restoreFrom = join(dir, 'pre-commit.db'); copyFileSync(join(dir, 'flashydex-user.db'), control.restoreFrom); } };
}

describe('R02 persistence latch', () => {
  it('a failed flush latches: PERSISTENCE_FAILED now, every later write refused (no silent double apply), reads + status still work', async () => {
    const t = await setup();
    const seen: StorageStatus[] = [];
    t.storage.subscribe((s) => seen.push(s));
    t.control.failNext = true;
    await expect(t.h.collection.add(copyOf('tset-001'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(t.storage.status()).toMatchObject({ writable: false, reason: 'persistence_failed', message: expect.any(String) });
    expect(seen.at(-1)).toMatchObject({ writable: false, reason: 'persistence_failed' });
    // the manual-retry hazard of E3 (2 -> 4): the retry is REFUSED, not applied
    await expect(t.h.collection.add(copyOf('tset-001'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    await expect(t.h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001') })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    await expect(t.h.settings.update({ defaultCurrency: 'EUR' })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(await ownedCount(t.h)).toBe(1); // exactly the one committed copy
    expect((await t.h.collection.list({ groupBy: 'copy' })).data).toHaveLength(1); // reads still work
  });

  it('recover() = driver.reopen(): POST-commit persisted state -> the copy is there; writes work again; no replay by core', async () => {
    const t = await setup();
    t.control.failNext = true;
    await expect(t.h.collection.add(copyOf('tset-001'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    const statuses: StorageStatus[] = [];
    t.storage.subscribe((s) => statuses.push(s));
    expect(await t.storage.recover()).toMatchObject({ writable: true, reason: 'ok' });
    expect(statuses.at(-1)).toMatchObject({ writable: true });
    expect(await ownedCount(t.h)).toBe(1);
    await t.h.collection.add(copyOf('tset-002'));
    expect(await ownedCount(t.h)).toBe(2);
  });

  it('recover() with PRE-commit persisted state: reopen shows the old state (the UI refetches and the user sees the truth); core does not replay', async () => {
    const t = await setup();
    t.snapshot(); // what the store really holds before the failed flush
    t.control.failNext = true;
    await expect(t.h.collection.add(copyOf('tset-001'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(await ownedCount(t.h)).toBe(1); // in-memory only
    await t.storage.recover();
    expect(await ownedCount(t.h)).toBe(0); // persisted truth
    await t.h.collection.add(copyOf('tset-001'));
    expect(await ownedCount(t.h)).toBe(1);
  });

  it('transfer commit is receipt-first: commit -> flush fault -> recover(POST) -> retry applies exactly once', async () => {
    const t = await setup();
    const platform = createMemoryPlatform(t.h.t.env);
    const transfer = new TransferService(t.h.ctx, platform);
    // build an import file from a second database
    const src = await harness();
    open.push(src);
    await installStandardCatalog(src);
    await src.collection.add(copyOf('tset-001'));
    await src.collection.add(copyOf('tset-002'));
    const srcPlatform = createMemoryPlatform(src.t.env);
    const file = await new TransferService(src.ctx, srcPlatform).exportFile({ format: 'json' });
    const ref = platform.put('in.json', srcPlatform.files.get(file.file.id)!.bytes, 'application/json');
    const report = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    t.control.failNext = true;
    await expect(transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    // N05: while persistence is uncertain, replay is REFUSED (never a success built from a receipt that may not be durable) ...
    await expect(transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(t.storage.status()).toMatchObject({ writable: false, reason: 'persistence_failed' });
    await t.storage.recover(); // reopen returns the POST-commit state (receipt included)
    // ... and after recovery the receipt is found FIRST and returned, never applied a second time
    const replay = await transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(replay).toMatchObject({ createdCopies: 2 });
    expect(await ownedCount(t.h)).toBe(2);
    const again = await transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(again).toMatchObject({ createdCopies: 2 });
    expect(await ownedCount(t.h)).toBe(2); // exactly one application
  });

  it('transfer commit with PRE-commit persisted state: recover() then retry applies exactly once (the receipt was lost with the commit)', async () => {
    const t = await setup();
    const platform = createMemoryPlatform(t.h.t.env);
    const transfer = new TransferService(t.h.ctx, platform);
    const src = await harness();
    open.push(src);
    await installStandardCatalog(src);
    await src.collection.add(copyOf('tset-001'));
    await src.collection.add(copyOf('tset-002'));
    const srcPlatform = createMemoryPlatform(src.t.env);
    const file = await new TransferService(src.ctx, srcPlatform).exportFile({ format: 'json' });
    const ref = platform.put('in.json', srcPlatform.files.get(file.file.id)!.bytes, 'application/json');
    const report = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
    t.snapshot();
    t.control.failNext = true;
    await expect(transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    // N05 (Sol's PRE-persisted probe): the in-memory receipt exists but was never durable -> refused before recovery, not "createdCopies: 2"
    await expect(transfer.commit({ id: report.id, planHash: report.planHash, confirm: true })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    await t.storage.recover(); // PRE-commit: nothing persisted, no receipt either
    expect(await ownedCount(t.h)).toBe(0);
    const again = await transfer.commit({ id: report.id, planHash: report.planHash, confirm: true });
    expect(again).toMatchObject({ createdCopies: 2 });
    expect(await ownedCount(t.h)).toBe(2);
  });

  it('INSTANCE_LOCK (D42): every personal write is refused, reads work, status says why; clearing the lock re-enables writes', async () => {
    const t = await setup();
    await t.h.collection.add(copyOf('tset-001'));
    t.h.t.user.setInstanceLock({ message: 'Another tab has FlashyDex open. Close it or reload.' });
    expect(t.storage.status()).toMatchObject({ writable: false, reason: 'instance_lock', message: expect.stringContaining('Another tab') });
    await expect(t.h.collection.add(copyOf('tset-002'))).rejects.toMatchObject({ code: 'INSTANCE_LOCK' });
    await expect(t.h.settings.update({ defaultCurrency: 'EUR' })).rejects.toMatchObject({ code: 'INSTANCE_LOCK' });
    expect((await t.h.collection.list({ groupBy: 'copy' })).data).toHaveLength(1);
    t.h.t.user.setInstanceLock(null);
    await t.h.collection.add(copyOf('tset-002'));
    expect(await ownedCount(t.h)).toBe(2);
  });

  it('recover() on a driver without reopen() throws UNSUPPORTED_CAPABILITY and stays latched (UI must reload)', async () => {
    const t = await setup();
    const driver = t.h.t.user.driver as { reopen?: unknown };
    t.control.failNext = true;
    await expect(t.h.collection.add(copyOf('tset-001'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    const saved = driver.reopen;
    delete driver.reopen;
    await expect(t.storage.recover()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(t.storage.status().reason).toBe('persistence_failed');
    driver.reopen = saved;
    await t.storage.recover();
    expect(t.storage.status().writable).toBe(true);
  });
});
