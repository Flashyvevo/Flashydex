import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { FDX_LIMITS, type FileRef } from '@flashydex/schemas';
import { buildArchive, parseArchive } from '../src/backup/archive';
import { BackupService, type BackupServiceOptions } from '../src/backup/service';
import { DomainError } from '../src/errors';
import { createMemoryPlatform, type MemoryPlatform } from '../src/testing/memory-platform';
import { observationKeyOf } from '../src/transfer/import-plan';
import { copyOf, customCopy, harness, installCatalog, installStandardCatalog, testCards, TEST_SET, type Harness } from './helpers';

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

const mkHarness = async (): Promise<Harness> => {
  const h = await harness();
  open.push(h);
  return h;
};
const serviceFor = (h: Harness, platform: MemoryPlatform, options?: BackupServiceOptions) => new BackupService(h.ctx, platform, '9.9.9-test', options);
const sha = (platform: MemoryPlatform, bytes: Uint8Array) => platform.hash.sha256(bytes);
const bytesOf = (platform: MemoryPlatform, file: FileRef): Uint8Array => platform.files.get(file.id)!.bytes;
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof DomainError) return e.code; throw e; }
  return 'NO_ERROR';
};

/** Realistic dummy personal data: EN+JA overlapping ids, graded copy, custom card, acquisition, group, location, scan sessions, prices. */
async function seed(h: Harness) {
  await h.settings.update({ languages: ['en', 'ja'], defaultCurrency: 'EUR', disclaimerAcknowledged: true, onboardingCompleted: true, hideTcgPocket: false, setsFollowed: [{ language: 'en', setId: 'tset' }] });
  const loc = await h.collection.createLocation({ name: 'Binder A', description: 'Top shelf' });
  const grp = await h.collection.createGroup({ name: 'Favourites' });
  const custom = await h.collection.createCustom({ name: 'Prototype Mon', language: 'en', setId: 'proto', localId: '7' });
  const graded = await h.collection.add(copyOf('tset-001', { condition: 'NM', storageLocationId: loc.id, groupIds: [grp.id], grade: { company: 'PSA', grade: '10', certNumber: '12345678' } as never, purchasePrice: { cents: 500, currency: 'USD' }, acquisition: { create: { source: 'Local shop', purchasedOn: '2024-01-02' } } }));
  const zero = await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo', condition: 'LP', purchasePrice: { cents: 0, currency: 'USD' }, notes: 'gift' }));
  await h.collection.add(copyOf('tset-002', { manualPrice: { cents: 1234, currency: 'EUR' } }));
  await h.collection.add(copyOf('tset-001', { language: 'ja', condition: 'MP' }));
  await h.collection.add(customCopy(custom.id, { notes: 'hand made' }));
  // scan sessions (open + closed), one linked to a copy
  await h.t.user.run("INSERT INTO scan_sessions (id, status, started_at, ended_at, notes) VALUES ('11111111-1111-4111-8111-111111111111', 'open', '2026-10-01T10:00:00.000Z', NULL, 'live')");
  await h.t.user.run("INSERT INTO scan_sessions (id, status, started_at, ended_at, notes) VALUES ('22222222-2222-4222-8222-222222222222', 'closed', '2026-10-02T10:00:00.000Z', '2026-10-02T11:00:00.000Z', NULL)");
  await h.t.user.run("UPDATE owned_cards SET scan_session_id = '22222222-2222-4222-8222-222222222222' WHERE id = ?", [zero.id]);
  // price history for an owned identity AND for an identity nothing owns any more (unowned history must survive)
  await h.t.user.run("INSERT OR IGNORE INTO catalog_identities (language, id, created_at) VALUES ('en', 'gone-001', '2025-05-05T05:05:05.000Z')");
  const price = (id: string, cardId: string, cents: number, at: string) => {
    const row = { id, catalogCardId: cardId, language: 'en' as const, source: 'tcgplayer' as const, variant: 'normal' as const, variantDetail: '', providerVariantKey: 'normal', currency: 'USD' as const, lowCents: null, midCents: cents, highCents: null, marketCents: cents, trendCents: null, sourceUpdatedAt: at, capturedAt: at, observationKey: '' };
    row.observationKey = observationKeyOf(row);
    return row;
  };
  for (const p of [price('aaaaaaaa-0000-4000-8000-000000000001', 'tset-001', 150, '2026-09-01T00:00:00.000Z'), price('aaaaaaaa-0000-4000-8000-000000000002', 'tset-001', 175, '2026-09-15T00:00:00.000Z'), price('aaaaaaaa-0000-4000-8000-000000000003', 'gone-001', 99, '2026-08-01T00:00:00.000Z')]) {
    await h.t.user.run(
      'INSERT INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [p.id, p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents, p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey]
    );
  }
  await h.t.user.run("INSERT INTO catalog_annotations (language, catalog_card_id, display_overrides_json, notes, created_at, updated_at) VALUES ('en', 'tset-002', '{\"name\":\"Beta Mon (mine)\"}', 'favourite', '2026-09-20T00:00:00.000Z', '2026-09-21T00:00:00.000Z')");
  return { loc, grp, custom, graded, zero };
}

const PERSONAL = ['catalog_identities', 'catalog_annotations', 'price_snapshots', 'custom_cards', 'acquisitions', 'storage_locations', 'collection_groups', 'scan_sessions', 'owned_cards', 'grades', 'collection_group_members'];
async function canonicalDump(h: Harness): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of PERSONAL) out[t] = await h.t.user.rows(`SELECT * FROM ${t} ORDER BY 1, 2`);
  out.app_settings = await h.t.user.rows('SELECT * FROM app_settings');
  return JSON.stringify(out);
}
async function everything(h: Harness): Promise<string> {
  const tables = (await h.t.user.rows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((r) => String(r[0]));
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await h.t.user.rows(`SELECT * FROM ${t} ORDER BY 1, 2`);
  return JSON.stringify(out);
}
const revisionOf = async (h: Harness) => Number(await h.t.user.scalar("SELECT collection_revision FROM app_state WHERE id = 'collection'"));

async function sourceWithBackup() {
  const src = await mkHarness();
  await installStandardCatalog(src, 'en');
  await installStandardCatalog(src, 'ja');
  const platform = createMemoryPlatform(src.t.env);
  const seeded = await seed(src);
  const service = serviceFor(src, platform);
  const created = await service.create({});
  return { src, platform, seeded, created, dump: await canonicalDump(src), srcService: service };
}

async function restoreInto(target: Harness, platform: MemoryPlatform, file: FileRef, options?: BackupServiceOptions) {
  const service = serviceFor(target, platform, options);
  const preview = await service.previewRestore({ file });
  const result = await service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' });
  return { service, preview, result };
}

describe('.fdx create', () => {
  it('writes a valid allowlisted ZIP with manifest, entities, settings and full personal history', async () => {
    const { platform, created, src } = await sourceWithBackup();
    expect(created.format).toBe('fdx');
    expect(created.backupVersion).toBe(1);
    expect(created.file.name).toMatch(/^flashydex-\d{8}T\d{6}Z\.fdx$/);
    expect(created.file.mime).toBe('application/vnd.flashydex.backup+zip');
    const bytes = bytesOf(platform, created.file);
    expect(created.sha256).toBe(await sha(platform, bytes));
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['entities.json', 'manifest.json', 'settings.json']);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!));
    expect(manifest.entries.map((e: { path: string }) => e.path).sort()).toEqual(['entities.json', 'settings.json']);
    expect(manifest.entries.every((e: { compression: string }) => e.compression === 'deflate')).toBe(true);
    const entities = JSON.parse(new TextDecoder().decode(files['entities.json']!));
    expect(created.counts).toEqual(manifest.counts);
    expect(created.counts).toMatchObject({ ownedCards: 5, customCards: 1, acquisitions: 1, grades: 1, storageLocations: 1, collectionGroups: 1, collectionGroupMembers: 1, scanSessions: 2, priceSnapshots: 3, catalogAnnotations: 1, userImages: 0 });
    expect(created.counts.catalogIdentities).toBe(4);
    // unowned history/annotations/identities are included; refs are one per owned identity
    expect(entities.priceSnapshots.some((p: { catalogCardId: string }) => p.catalogCardId === 'gone-001')).toBe(true);
    expect(entities.catalogIdentities.map((i: { id: string }) => i.id)).toContain('gone-001');
    expect(entities.catalogRefs).toHaveLength(3);
    expect(JSON.parse(new TextDecoder().decode(files['settings.json']!)).imageCacheLimitBytes).toBe(200000000);
    expect(await revisionOf(src)).toBeGreaterThan(0); // create never bumps it
  });

  it('manifest carries informational catalog version hints from the install receipts (none when nothing is installed)', async () => {
    const { platform, src } = await sourceWithBackup();
    await src.t.user.run("UPDATE installed_catalogs SET status = 'installed', version = '2026.10.31.001', sha256 = ?, installed_at = '2026-10-31T00:00:00.000Z', schema_version = 1, active_ref = 'ref-en', generation = generation + 1 WHERE language = 'en'", ['a'.repeat(64)]);
    const again = await serviceFor(src, platform).create({});
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(bytesOf(platform, again.file))['manifest.json']!));
    expect(manifest.catalogs).toEqual([{ language: 'en', version: '2026.10.31.001', schemaVersion: 1, baselineSha256: 'a'.repeat(64), entryPath: null, rawSha256: null, uncompressedBytes: null }]);
    expect(manifest.includesCatalogs).toBe(false);
    const bare = await mkHarness();
    const bp = createMemoryPlatform(bare.t.env);
    const bareFile = await serviceFor(bare, bp).create({});
    expect(JSON.parse(new TextDecoder().decode(unzipSync(bytesOf(bp, bareFile.file))['manifest.json']!)).catalogs).toEqual([]);
  });

  it('is deterministic for an unchanged collection (entity bytes identical, ordered by id)', async () => {
    const { platform, srcService, created } = await sourceWithBackup();
    const again = await srcService.create({});
    const a = unzipSync(bytesOf(platform, created.file));
    const b = unzipSync(bytesOf(platform, again.file));
    expect(new TextDecoder().decode(a['entities.json']!)).toBe(new TextDecoder().decode(b['entities.json']!));
    const ids = JSON.parse(new TextDecoder().decode(a['entities.json']!)).ownedCards.map((c: { id: string }) => c.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects includeCatalogs, warns for includeUserImages, reports capabilities, isolates progress callback errors', async () => {
    const { platform, srcService, src } = await sourceWithBackup();
    expect(await codeOf(srcService.create({ includeCatalogs: true }))).toBe('UNSUPPORTED_CAPABILITY');
    const phases: string[] = [];
    const withImages = await srcService.create({ includeUserImages: true }, (p) => { phases.push(p.phase); throw new Error('observer blew up'); });
    expect(withImages.warnings.length).toBe(1);
    expect(withImages.counts.userImages).toBe(0);
    expect(phases).toEqual(['snapshot', 'compressing', 'verifying', 'complete']);
    expect(await srcService.capabilities()).toEqual({ fdxCreate: true, fdxRestore: true, optionalCatalogPayload: false, reason: null });
    void platform; void src;
  });

  it('honors an aborted signal before anything is written', async () => {
    const { platform, srcService } = await sourceWithBackup();
    const before = platform.files.size;
    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(srcService.create({}, undefined, controller.signal))).toBe('CANCELLED');
    expect(platform.files.size).toBe(before);
  });
});

describe('round trip: create -> wipe -> fresh migrate -> restore', () => {
  it('same catalogs: canonical dump (all personal tables + settings) is identical', async () => {
    const { platform, created, dump, src } = await sourceWithBackup();
    const target = await mkHarness();
    await installStandardCatalog(target, 'en');
    await installStandardCatalog(target, 'ja');
    const { preview, result } = await restoreInto(target, platform, created.file);
    expect(preview).toMatchObject({ matchedCatalogIdentities: 3, missingCatalogIdentities: 1, totalCards: 5, customCards: 1, backupVersion: 1, warning: 'Replaces all personal data' });
    expect(preview.backupHash).toBe(created.sha256);
    expect(result).toMatchObject({ restored: true, totalCards: 5, restartRequired: false });
    expect(await canonicalDump(target)).toBe(dump);
    expect(await revisionOf(target)).toBe(preview.collectionRevision + 1);
    expect(await target.settings.get()).toEqual(await src.settings.get());
    const receipts = await target.t.user.rows('SELECT id, backup_hash FROM restore_receipts');
    expect(receipts).toEqual([[preview.id, created.sha256]]);
    expect(await target.t.user.rows('SELECT * FROM work_admission')).toEqual([]);
  });

  it('NO catalog installed: all identities missing, identical ownership, never an error', async () => {
    const { platform, created, dump } = await sourceWithBackup();
    const target = await mkHarness();
    const { preview } = await restoreInto(target, platform, created.file);
    expect(preview.matchedCatalogIdentities).toBe(0);
    expect(preview.missingCatalogIdentities).toBe(4);
    expect(preview.warnings.some((w) => w.includes('not in the installed catalog'))).toBe(true);
    expect(await canonicalDump(target)).toBe(dump);
    // owned-copy snapshots are restored as-is (no re-ID, no custom conversion)
    expect(Number(await target.t.user.scalar("SELECT COUNT(*) FROM owned_cards WHERE catalog_card_id IS NOT NULL AND name = 'Alpha Mon'"))).toBe(3);
  });

  it('NEWER / different catalog (EN trimmed, no JA): matched/missing reported, ownership equal, no row changed', async () => {
    const { platform, created, dump } = await sourceWithBackup();
    const target = await mkHarness();
    await installCatalog(target, 'en', { sets: [TEST_SET], cards: testCards().slice(0, 2).map((c) => ({ ...c, name: `${c.name} (newer)` })) });
    const { preview } = await restoreInto(target, platform, created.file);
    expect(preview.matchedCatalogIdentities).toBe(2); // en tset-001, tset-002
    expect(preview.missingCatalogIdentities).toBe(2); // ja tset-001, en gone-001
    expect(await canonicalDump(target)).toBe(dump);
  });

  it('replaces pre-existing personal data and keeps operational tables from the device', async () => {
    const { platform, created, dump } = await sourceWithBackup();
    const target = await mkHarness();
    await installStandardCatalog(target, 'en');
    await target.collection.add(copyOf('tset-005', { notes: 'will be replaced' }));
    await target.settings.update({ defaultCurrency: 'USD', hideTcgPocket: true });
    await target.t.user.run("INSERT INTO data_operation_receipts (id, operation, plan_hash, result_json, committed_at, expires_at) VALUES ('33333333-3333-4333-8333-333333333333', 'import', 'h', '{}', '2026-10-30T00:00:00.000Z', '2027-10-30T00:00:00.000Z')");
    const opsBefore = JSON.stringify([await target.t.user.rows('SELECT * FROM data_operation_receipts'), await target.t.user.rows('SELECT * FROM installed_catalogs'), await target.t.user.rows('SELECT version FROM schema_migrations')]);
    await restoreInto(target, platform, created.file);
    expect(await canonicalDump(target)).toBe(dump);
    const opsAfter = JSON.stringify([await target.t.user.rows('SELECT * FROM data_operation_receipts'), await target.t.user.rows('SELECT * FROM installed_catalogs'), await target.t.user.rows('SELECT version FROM schema_migrations')]);
    expect(opsAfter).toBe(opsBefore);
    expect(Number(await target.t.user.scalar("SELECT COUNT(*) FROM owned_cards WHERE notes = 'will be replaced'"))).toBe(0);
  });

  it('preview performs ZERO database writes', async () => {
    const { platform, created } = await sourceWithBackup();
    const target = await mkHarness();
    await installStandardCatalog(target, 'en');
    await target.collection.add(copyOf('tset-003'));
    const before = await everything(target);
    const service = serviceFor(target, platform);
    await service.previewRestore({ file: created.file });
    expect(await everything(target)).toBe(before);
  });
});

describe('restore guards', () => {
  async function previewed() {
    const base = await sourceWithBackup();
    const target = await mkHarness();
    await installStandardCatalog(target, 'en');
    await target.collection.add(copyOf('tset-004', { notes: 'mine' }));
    const service = serviceFor(target, base.platform);
    const preview = await service.previewRestore({ file: base.created.file });
    const commit = { id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' as const };
    return { ...base, target, service, preview, commit };
  }

  it('ALREADY_RESTORED on a second restore of the same preview (same instance and a fresh instance via receipt)', async () => {
    const { target, service, commit, platform } = await previewed();
    await service.restore(commit);
    expect(await codeOf(service.restore(commit))).toBe('ALREADY_RESTORED');
    expect(await codeOf(serviceFor(target, platform).restore(commit))).toBe('ALREADY_RESTORED');
  });

  it('STALE_PREVIEW after a collection edit between preview and restore; target unchanged', async () => {
    const { target, service, commit } = await previewed();
    await target.collection.add(copyOf('tset-002'));
    const before = await canonicalDump(target);
    expect(await codeOf(service.restore(commit))).toBe('STALE_PREVIEW');
    expect(await canonicalDump(target)).toBe(before);
    expect(await target.t.user.rows('SELECT * FROM work_admission')).toEqual([]);
  });

  it('STALE_PREVIEW after a settings-only edit (no revision bump) via userStateToken', async () => {
    const { target, service, commit } = await previewed();
    const revBefore = await revisionOf(target);
    await target.settings.update({ defaultCurrency: 'EUR' });
    expect(await revisionOf(target)).toBe(revBefore);
    expect(await codeOf(service.restore(commit))).toBe('STALE_PREVIEW');
  });

  it('STALE_PREVIEW after an annotation edit (token covers annotation state)', async () => {
    const { target, service, commit } = await previewed();
    await target.t.user.run("INSERT OR IGNORE INTO catalog_identities (language, id, created_at) VALUES ('en', 'tset-003', '2026-10-30T00:00:00.000Z')");
    await target.t.user.run("INSERT INTO catalog_annotations (language, catalog_card_id, display_overrides_json, notes, created_at, updated_at) VALUES ('en', 'tset-003', '{}', 'x', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')");
    expect(await codeOf(service.restore(commit))).toBe('STALE_PREVIEW');
  });

  it('PREVIEW_EXPIRED after 10 minutes; NOT_FOUND for an unknown id; BACKUP_HASH_MISMATCH for a wrong hash', async () => {
    const { target, service, commit, preview } = await previewed();
    expect(await codeOf(service.restore({ ...commit, id: '44444444-4444-4444-8444-444444444444' }))).toBe('NOT_FOUND');
    expect(await codeOf(service.restore({ ...commit, backupHash: 'a'.repeat(64) }))).toBe('BACKUP_HASH_MISMATCH');
    expect(Date.parse(preview.expiresAt) - Date.parse('2026-10-30T12:00:00.000Z')).toBeLessThan(11 * 60 * 1000);
    target.t.env.setTime(new Date(Date.parse(preview.expiresAt) + 1000).toISOString());
    expect(await codeOf(service.restore(commit))).toBe('PREVIEW_EXPIRED');
  });

  it('ACTIVE_WORK while an install admission is held; works after release', async () => {
    const { target, service, commit } = await previewed();
    const lease = await target.t.databases.coordinator.admit('install', { languages: ['en'], token: '55555555-5555-4555-8555-555555555555', now: '2026-10-30T12:00:00.000Z' });
    const before = await canonicalDump(target);
    expect(await codeOf(service.restore(commit))).toBe('ACTIVE_WORK');
    expect(await canonicalDump(target)).toBe(before);
    await lease.release();
    await expect(service.restore(commit)).resolves.toMatchObject({ restored: true });
  });

  it('cancellation before the transaction leaves the target unchanged and releases admission', async () => {
    const { target, service, commit, platform } = await previewed();
    const before = await everything(target);
    const filesBefore = platform.files.size;
    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(service.restore(commit, undefined, controller.signal))).toBe('CANCELLED');
    expect(await everything(target)).toBe(before);
    expect(platform.files.size).toBe(filesBefore);
    // also: abort raised during the safety-backup phase
    const c2 = new AbortController();
    expect(await codeOf(service.restore(commit, (p) => { if (p.phase === 'verifying') c2.abort(); }, c2.signal))).toBe('CANCELLED');
    expect(await everything(target)).toBe(before);
    expect(platform.files.size).toBe(filesBefore); // the orphan safety backup is removed
    await expect(service.restore(commit)).resolves.toMatchObject({ restored: true }); // preview still valid
  });

  it('failure mid-restore (injected after delete+insert) rolls back: rows, settings, revision, receipts unchanged', async () => {
    const base = await sourceWithBackup();
    const target = await mkHarness();
    await installStandardCatalog(target, 'en');
    await target.collection.add(copyOf('tset-004', { notes: 'keep me' }));
    await target.settings.update({ defaultCurrency: 'USD' });
    let failAt: string | null = 'afterInsert';
    const service = serviceFor(target, base.platform, { hooks: { duringRestore: (stage) => { if (stage === failAt) throw new Error('boom'); } } });
    const preview = await service.previewRestore({ file: base.created.file });
    const commit = { id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' as const };
    const before = await everything(target);
    const filesBefore = base.platform.files.size;
    for (const stage of ['afterInsert', 'afterDelete']) {
      failAt = stage;
      await expect(service.restore(commit)).rejects.toThrow();
      expect(await everything(target)).toBe(before);
      expect(base.platform.files.size).toBe(filesBefore);
    }
    failAt = null;
    await expect(service.restore(commit)).resolves.toMatchObject({ restored: true });
    expect(await canonicalDump(target)).toBe(base.dump);
  });

  it('the safety backup is a valid verifiable .fdx whose restore returns the pre-restore state', async () => {
    const { target, service, commit, platform } = await previewed();
    const preState = await canonicalDump(target);
    const result = await service.restore(commit);
    expect(await canonicalDump(target)).not.toBe(preState);
    expect(result.safetyBackup.name).toMatch(/\.fdx$/);
    const safetyBytes = bytesOf(platform, result.safetyBackup);
    const parsed = await parseArchive(safetyBytes, (b) => sha(platform, b));
    expect(parsed.entities.ownedCards.map((c) => c.notes)).toEqual(['mine']);
    const back = await restoreInto(target, platform, result.safetyBackup);
    expect(back.preview.backupHash).toBe(await sha(platform, safetyBytes));
    expect(await canonicalDump(target)).toBe(preState);
  });
});

describe('hostile archives are rejected before any write', () => {
  async function fixture() {
    const base = await sourceWithBackup();
    const target = await mkHarness();
    const before = await everything(target);
    const entries = unzipSync(bytesOf(base.platform, base.created.file));
    const json = (name: string) => JSON.parse(new TextDecoder().decode(entries[name]!));
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const expectReject = async (bytes: Uint8Array, code: string, options?: BackupServiceOptions) => {
      const file = base.platform.put('flashydex-evil.fdx', bytes);
      const service = serviceFor(target, base.platform, options);
      expect(await codeOf(service.previewRestore({ file }))).toBe(code);
      expect(await everything(target)).toBe(before);
    };
    /** A structurally valid archive from (possibly tampered) entities/settings with correct hashes. */
    const rebuild = async (mutate?: (e: Record<string, unknown>, s: Record<string, unknown>) => void) => {
      const e = json('entities.json');
      const s = json('settings.json');
      mutate?.(e, s);
      return (await buildArchive({ entities: e as never, settings: s as never, createdAt: '2026-10-30T12:00:00.000Z', appVersion: '1', backupId: '66666666-6666-4666-8666-666666666666', hash: (b) => sha(base.platform, b) })).bytes;
    };
    return { ...base, target, entries, json, enc, expectReject, rebuild };
  }

  it('garbage bytes, empty file, truncated archive', async () => {
    const f = await fixture();
    await f.expectReject(new TextEncoder().encode('definitely not a zip file at all, just text'), 'BACKUP_INVALID');
    await f.expectReject(new Uint8Array(0), 'BACKUP_INVALID');
    const good = bytesOf(f.platform, f.created.file);
    await f.expectReject(good.subarray(0, Math.floor(good.length / 2)), 'BACKUP_INVALID');
  });

  it('zip bomb: tiny archive whose entities.json inflates past the cap (counted on ACTUAL output)', async () => {
    const f = await fixture();
    const bomb = zipSync({
      'manifest.json': f.entries['manifest.json']!,
      'settings.json': f.entries['settings.json']!,
      'entities.json': [new Uint8Array(8 * 1024 * 1024), { level: 9 }] // 8 MiB of zeros -> a few KiB compressed
    });
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    await f.expectReject(bomb, 'SIZE_LIMIT', { limits: { entityBytes: 1024 * 1024 } });
    // and the same bytes are not rejected by the ratio but by the cap: with the default 128 MiB cap the failure is a content error, not SIZE_LIMIT
    await f.expectReject(bomb, 'BACKUP_HASH_MISMATCH');
  });

  it('aggregate expanded-bytes cap', async () => {
    const f = await fixture();
    await f.expectReject(bytesOf(f.platform, f.created.file), 'SIZE_LIMIT', { limits: { expandedBytes: 100 } });
  });

  it('oversize archive (compressed cap) and entry-count cap', async () => {
    const f = await fixture();
    const good = bytesOf(f.platform, f.created.file);
    await f.expectReject(good, 'SIZE_LIMIT', { limits: { archiveBytes: good.byteLength - 1 } });
    await f.expectReject(good, 'SIZE_LIMIT', { limits: { entries: 2 } });
    expect(FDX_LIMITS.archiveBytes).toBe(512 * 1024 * 1024);
  });

  it('row caps (total and owned) on the parsed document', async () => {
    const f = await fixture();
    await f.expectReject(bytesOf(f.platform, f.created.file), 'SIZE_LIMIT', { limits: { totalRows: 10 } });
    await f.expectReject(bytesOf(f.platform, f.created.file), 'SIZE_LIMIT', { limits: { ownedRows: 2 } });
  });

  it('duplicate zip entry', async () => {
    const f = await fixture();
    // 'entities.json' and 'entitieX.json' have equal length; rename the second in both local and central headers.
    const zipped = zipSync({ 'manifest.json': f.entries['manifest.json']!, 'entities.json': f.entries['entities.json']!, 'entitieX.json': f.entries['entities.json']!, 'settings.json': f.entries['settings.json']! });
    const a = new TextEncoder().encode('entitieX.json');
    const b = new TextEncoder().encode('entities.json');
    for (let i = 0; i + a.length <= zipped.length; i += 1) if (a.every((x, k) => zipped[i + k] === x)) zipped.set(b, i);
    await f.expectReject(zipped, 'BACKUP_INVALID');
  });

  it('unsafe paths: "..", absolute, backslash, drive letter, NUL, unknown entry', async () => {
    const f = await fixture();
    const base = { 'manifest.json': f.entries['manifest.json']!, 'entities.json': f.entries['entities.json']!, 'settings.json': f.entries['settings.json']! };
    for (const name of ['../evil.txt', 'images/../../evil.png', '/etc/passwd', 'C:/evil.txt', 'images\\evil.png', 'a\0b.json']) {
      await f.expectReject(zipSync({ ...base, [name]: new Uint8Array([1, 2, 3]) }), 'BACKUP_UNSAFE_ENTRY');
    }
    await f.expectReject(zipSync({ ...base, 'notes.txt': new Uint8Array([1]) }), 'BACKUP_INVALID');
    await f.expectReject(zipSync({ ...base, 'images/not-a-uuid.png': new Uint8Array([1]) }), 'BACKUP_INVALID');
  });

  it('encrypted flag and symlink entries', async () => {
    const f = await fixture();
    const patch = (apply: (view: DataView, at: number) => void) => {
      const copy = new Uint8Array(bytesOf(f.platform, f.created.file));
      const view = new DataView(copy.buffer);
      for (let i = 0; i + 4 <= copy.length; i += 1) if (view.getUint32(i, true) === 0x02014b50) { apply(view, i); break; }
      return copy;
    };
    await f.expectReject(patch((v, at) => v.setUint16(at + 8, v.getUint16(at + 8, true) | 1, true)), 'BACKUP_INVALID');
    await f.expectReject(patch((v, at) => { v.setUint16(at + 4, (3 << 8) | 20, true); v.setUint32(at + 38, 0xa1ff << 16, true); }), 'BACKUP_UNSAFE_ENTRY');
  });

  it('missing required entry', async () => {
    const f = await fixture();
    for (const name of ['manifest.json', 'entities.json', 'settings.json']) {
      const rest = Object.fromEntries(Object.entries(f.entries).filter(([k]) => k !== name));
      await f.expectReject(zipSync(rest), 'BACKUP_INVALID');
    }
  });

  it('unknown backupVersion / entitiesVersion / settingsVersion -> BACKUP_VERSION_UNSUPPORTED', async () => {
    const f = await fixture();
    const manifest = f.json('manifest.json');
    await f.expectReject(zipSync({ ...f.entries, 'manifest.json': f.enc({ ...manifest, backupVersion: 2 }) }), 'BACKUP_VERSION_UNSUPPORTED');
    await f.expectReject(zipSync({ ...f.entries, 'manifest.json': f.enc({ ...manifest, entitiesVersion: 2 }) }), 'BACKUP_VERSION_UNSUPPORTED');
    await f.expectReject(await f.rebuild((e) => { e.entitiesVersion = 2; }), 'BACKUP_VERSION_UNSUPPORTED');
    await f.expectReject(await f.rebuild((_e, s) => { s.settingsVersion = 7; }), 'BACKUP_VERSION_UNSUPPORTED');
  });

  it('entry sha256 / size mismatch -> BACKUP_HASH_MISMATCH', async () => {
    const f = await fixture();
    const entities = f.json('entities.json');
    entities.ownedCards[0].notes = 'tampered after hashing';
    await f.expectReject(zipSync({ ...f.entries, 'entities.json': f.enc(entities) }), 'BACKUP_HASH_MISMATCH');
    const manifest = f.json('manifest.json');
    manifest.entries[0].sha256 = 'b'.repeat(64);
    await f.expectReject(zipSync({ ...f.entries, 'manifest.json': f.enc(manifest) }), 'BACKUP_HASH_MISMATCH');
  });

  it('manifest count mismatch -> BACKUP_COUNT_MISMATCH', async () => {
    const f = await fixture();
    const manifest = f.json('manifest.json');
    manifest.counts.ownedCards += 1;
    await f.expectReject(zipSync({ ...f.entries, 'manifest.json': f.enc(manifest) }), 'BACKUP_COUNT_MISMATCH');
  });

  it('manifest not listing / listing wrong entries', async () => {
    const f = await fixture();
    const manifest = f.json('manifest.json');
    manifest.entries.pop();
    await f.expectReject(zipSync({ ...f.entries, 'manifest.json': f.enc(manifest) }), 'BACKUP_INVALID');
  });

  it('semantic violations: dangling FKs, duplicate PK, bad observationKey, strict zod extras', async () => {
    const f = await fixture();
    await f.expectReject(await f.rebuild((e) => { (e.ownedCards as Array<Record<string, unknown>>)[0]!.acquisitionId = '77777777-7777-4777-8777-777777777777'; }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((e) => { (e.grades as Array<Record<string, unknown>>)[0]!.ownedCardId = '77777777-7777-4777-8777-777777777777'; }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((e) => { e.catalogIdentities = (e.catalogIdentities as Array<{ id: string }>).filter((i) => i.id !== 'gone-001'); }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((e) => { const l = e.customCards as unknown[]; l.push(l[0]); }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((e) => { (e.priceSnapshots as Array<Record<string, unknown>>)[0]!.observationKey = 'c'.repeat(64); }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((e) => { (e.customCards as Array<Record<string, unknown>>)[0]!.surprise = true; }), 'BACKUP_INVALID');
    await f.expectReject(await f.rebuild((_e, s) => { s.disclaimerAcknowledgedAt = null; }), 'BACKUP_INVALID');
  });

  it('a hand-rebuilt valid archive restores (parser accepts what the builder writes)', async () => {
    const f = await fixture();
    const good = await f.rebuild();
    const file = f.platform.put('flashydex-ok.fdx', good);
    const service = serviceFor(f.target, f.platform);
    await expect(service.previewRestore({ file })).resolves.toMatchObject({ totalCards: 5 });
  });
});
