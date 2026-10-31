import { afterEach, describe, expect, it } from 'vitest';
import { BackupService, type BackupServiceOptions, type RestoreStage } from '../src/backup/backup-service';
import { CatalogInstallService } from '../src/services/catalog-install';
import type { StorageStatus } from '../src/db/sql';
import { DomainError } from '../src/errors';
import { StorageService } from '../src/services/storage';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { TransferService } from '../src/transfer/service';
import { copyOf, harness, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** Stage E / E1 + N03: the personal-write maintenance gate around restore (and the informational catalog_activation status). */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const fresh = async (): Promise<Harness> => { const h = await harness(); open.push(h); return h; };
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof DomainError) return e.code; return `RAW:${(e as Error).message}`; }
  return 'ACCEPTED';
};

const STAGES: RestoreStage[] = ['afterGate', 'duringSafety', 'afterSafety', 'afterDelete', 'afterInsert'];

async function fixture() {
  const h = await fresh();
  await installStandardCatalog(h);
  await h.settings.update({ defaultCurrency: 'EUR' });
  const archiveHide = (await h.settings.get()).hideTcgPocket;
  const c = await h.collection.add(copyOf("tset-001", { notes: "archive value" }));
  const platform = createMemoryPlatform(h.t.env);
  const backup = await new BackupService(h.ctx, platform).create({});
  await h.collection.update({ id: c.id, patch: { notes: 'current value' } });
  await h.settings.update({ defaultCurrency: 'USD' });
  // an import file + preview prepared BEFORE the restore, for the import-commit race
  const src = await fresh();
  await installStandardCatalog(src);
  await src.collection.add(copyOf('tset-003'));
  const srcPlatform = createMemoryPlatform(src.t.env);
  const exported = await new TransferService(src.ctx, srcPlatform).exportFile({ format: 'json' });
  const ref = platform.put('in.json', srcPlatform.files.get(exported.file.id)!.bytes, 'application/json');
  const transfer = new TransferService(h.ctx, platform);
  const importPreview = await transfer.dryRun({ format: 'json', conflictPolicy: 'skip', file: ref });
  return { h, c, platform, backup, transfer, importPreview, archiveHide };
}

describe('N03 restore refuses personal writes at every boundary (MAINTENANCE), final rows = archive values', () => {
  it.each(STAGES)('update / add / bulkAdd / settings / import-commit submitted at stage %s all reject MAINTENANCE and change nothing', async (stage) => {
    const f = await fixture();
    const raced: Array<[string, Promise<unknown>]> = [];
    const hooks: BackupServiceOptions['hooks'] = {
      duringRestore: (s) => {
        if (s !== stage) return;
        raced.push(['update', f.h.collection.update({ id: f.c.id, patch: { notes: 'stale edit during restore' } })]);
        raced.push(['add', f.h.collection.add(copyOf('tset-002', { notes: 'stale add' }))]);
        raced.push(['bulkAdd', f.h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-004') })]);
        raced.push(["settings", f.h.settings.update({ defaultCurrency: "USD", hideTcgPocket: !f.archiveHide })]);
        raced.push(['import', f.transfer.commit({ id: f.importPreview.id, planHash: f.importPreview.planHash, confirm: true })]);
      }
    };
    const service = new BackupService(f.h.ctx, f.platform, '0.0.0', { hooks });
    const preview = await service.previewRestore({ file: f.backup.file });
    const result = await service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' });
    expect(result.restored).toBe(true);
    const codes = await Promise.all(raced.map(async ([name, p]) => [name, await codeOf(p)] as const));
    expect(codes).toEqual([['update', 'MAINTENANCE'], ['add', 'MAINTENANCE'], ['bulkAdd', 'MAINTENANCE'], ['settings', 'MAINTENANCE'], ['import', 'MAINTENANCE']]);
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('archive value');
    expect(await ownedCount(f.h)).toBe(1);
    expect((await f.h.settings.get()).defaultCurrency).toBe('EUR');
    expect((await f.h.settings.get()).hideTcgPocket).toBe(f.archiveHide);
    // the gate is closed again afterwards: ordinary writes work
    await f.h.collection.update({ id: f.c.id, patch: { notes: 'after restore' } });
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('after restore');
  });

  it("Sol's probe: an ordinary CollectionRepo.update injected after DELETE is refused (was: accepted, finalNotes = stale edit)", async () => {
    const f = await fixture();
    let racing: Promise<string> | undefined;
    const service = new BackupService(f.h.ctx, f.platform, '0.0.0', {
      hooks: { duringRestore: (s) => { if (s === 'afterDelete') racing = codeOf(f.h.collection.update({ id: f.c.id, patch: { notes: 'stale edit during restore' } })); } }
    });
    const preview = await service.previewRestore({ file: f.backup.file });
    await service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' });
    expect(await racing).toBe('MAINTENANCE');
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('archive value');
  });

  it('a failed/stale restore reopens the gate (finally): ordinary writes work again and nothing changed', async () => {
    const f = await fixture();
    const service = new BackupService(f.h.ctx, f.platform);
    const preview = await service.previewRestore({ file: f.backup.file });
    await f.h.collection.update({ id: f.c.id, patch: { notes: 'edit after preview' } }); // moves the user-state token
    expect(await codeOf(service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' }))).toBe('STALE_PREVIEW');
    expect(f.h.t.user.status()).toMatchObject({ writable: true, reason: 'ok', maintenance: null });
    await f.h.collection.update({ id: f.c.id, patch: { notes: 'still writable' } });
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('still writable');
  });

  it('a hook that throws inside the privileged transaction rolls back AND reopens the gate', async () => {
    const f = await fixture();
    const service = new BackupService(f.h.ctx, f.platform, '0.0.0', { hooks: { duringRestore: (s) => { if (s === 'afterInsert') throw new Error('boom'); } } });
    const preview = await service.previewRestore({ file: f.backup.file });
    await expect(service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' })).rejects.toBeDefined();
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('current value');
    expect(f.h.t.user.status().maintenance).toBeNull();
    await f.h.collection.update({ id: f.c.id, patch: { notes: 'writable again' } });
  });

  it('the userStateToken is re-checked UNDER the gate: a write that lands between preview and the gate is STALE_PREVIEW, nothing restored', async () => {
    const f = await fixture();
    const service = new BackupService(f.h.ctx, f.platform);
    const preview = await service.previewRestore({ file: f.backup.file });
    await f.h.settings.update({ hideTcgPocket: true });
    expect(await codeOf(service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' }))).toBe('STALE_PREVIEW');
    expect((await f.h.collection.getCopy({ id: f.c.id })).notes).toBe('current value');
  });
});

describe('E1 Db-level gate semantics', () => {
  it('writes already QUEUED behind in-flight work when the gate closes reject MAINTENANCE; the in-flight one completes; the privileged transaction passes', async () => {
    const h = await fresh();
    const db = h.t.user;
    let release!: () => void;
    const slow = db.transaction(async (tx) => {
      await new Promise<void>((r) => { release = r; });
      await tx.run("UPDATE app_settings SET default_currency = 'EUR' WHERE id = 'app'");
    });
    await new Promise((r) => setTimeout(r, 5));
    const queued = db.transaction(async (tx) => { await tx.run("UPDATE app_settings SET default_currency = 'USD' WHERE id = 'app'"); });
    const queuedCode = codeOf(queued);
    const gatePromise = db.enterRestoreGate();
    release();
    await slow;
    const gate = await gatePromise;
    expect(await queuedCode).toBe('MAINTENANCE');
    await gate.transaction(async (tx) => { await tx.run("UPDATE app_settings SET hide_tcg_pocket = 1 WHERE id = 'app'"); });
    expect(await codeOf(db.transaction(async () => undefined))).toBe('MAINTENANCE');
    expect(Number(await db.scalar("SELECT default_currency = 'EUR' FROM app_settings"))).toBe(1); // in-flight write committed, queued one did not
    await gate.exit();
    expect(db.status()).toMatchObject({ writable: true, maintenance: null });
    await db.transaction(async () => undefined);
  });

  it('a second gate while one is closed is refused; reads keep working while closed', async () => {
    const h = await fresh();
    const gate = await h.t.user.enterRestoreGate();
    expect(await codeOf(h.t.user.enterRestoreGate())).toBe('MAINTENANCE');
    await expect(h.settings.get()).resolves.toBeDefined();
    await gate.exit();
  });
});

describe('E1 status / subscribe', () => {
  it('restore: subscribers see maintenance {kind:restore} while it runs (writable=false, reason maintenance) and null after', async () => {
    const f = await fixture();
    const storage = new StorageService(f.h.t.databases);
    const seen: StorageStatus[] = [];
    storage.subscribe((s) => seen.push(s));
    const service = new BackupService(f.h.ctx, f.platform);
    const preview = await service.previewRestore({ file: f.backup.file });
    await service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' });
    const enter = seen.find((s) => s.maintenance?.kind === 'restore');
    expect(enter).toMatchObject({ writable: false, reason: 'maintenance', maintenance: { kind: 'restore', language: null, since: expect.any(String) } });
    expect(seen.at(-1)).toMatchObject({ writable: true, reason: 'ok', maintenance: null });
    expect(storage.status()).toEqual({ writable: true, reason: 'ok', message: null, maintenance: null });
  });

  it('catalog install: maintenance {kind:catalog_activation, language} during the barrier; personal writes are NOT blocked; null afterwards', async () => {
    const h = await fresh();
    const port = new FakeDiskPort(h.t.dir, h.t.env);
    port.manifestJson = FakeDiskPort.manifest(['en']);
    const storage = new StorageService(h.t.databases);
    const seen: StorageStatus[] = [];
    storage.subscribe((s) => seen.push(s));
    let during: StorageStatus | null = null;
    let writeCode = '';
    port.hooks['activate:start'] = async () => {
      during = storage.status();
      writeCode = await codeOf(h.settings.update({ hideTcgPocket: true }));
    };
    await new CatalogInstallService(h.ctx, port, { trustedOrigins: ['https://example.test'] }).install('en', () => undefined, new AbortController().signal);
    expect(during).toMatchObject({ writable: true, reason: 'ok', maintenance: { kind: 'catalog_activation', language: 'en' } });
    expect(writeCode).toBe('ACCEPTED');
    expect(seen.some((s) => s.maintenance?.kind === 'catalog_activation')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ maintenance: null });
    expect(storage.status().maintenance).toBeNull();
  });

  it('the status object is referentially stable while nothing changed', async () => {
    const h = await fresh();
    expect(h.t.user.status()).toBe(h.t.user.status());
  });
});
