import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup/backup-service';
import { buildArchive, parseArchive } from '../src/backup/archive';
import { DomainError } from '../src/errors';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { harness, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** E02 (Sol review 3): correctly hashed archives with domain-invalid personal state are rejected at preview with BACKUP_INVALID. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

type Kind = 'custom-language' | 'followed-settings' | 'annotation-shape' | 'annotation-name' | 'reversed-audit' | 'followed-unselected' | 'scan-order';
const CASES: Array<[Kind, RegExp]> = [
  ['custom-language', /language differs from its custom card/],
  ['followed-settings', /Duplicate followed set|not selected/],
  ['followed-unselected', /not selected/],
  ['annotation-shape', /entities\.json is not valid/],
  ['annotation-name', /entities\.json is not valid/],
  ['reversed-audit', /updated before it was created/],
  ['scan-order', /ended before it started/]
];

async function fixture() {
  const src = await harness();
  open.push(src);
  await installStandardCatalog(src);
  const custom = await src.collection.createCustom({ name: 'Test Custom', language: 'en' });
  await src.collection.add({ language: 'en', customCardId: custom.id, variant: 'normal' });
  const platform = createMemoryPlatform(src.t.env);
  const backup = await new BackupService(src.ctx, platform).create({});
  const hash = (b: Uint8Array) => platform.hash.sha256(b);
  const raw = await parseArchive(platform.files.get(backup.file.id)!.bytes, hash);
  return { src, platform, hash, raw };
}

describe('E02 domain invariants in .fdx preview', () => {
  for (const [kind, reason] of CASES) {
    it(`${kind}: preview -> BACKUP_INVALID with a readable reason, target untouched`, async () => {
      const f = await fixture();
      const entities = structuredClone(f.raw.entities);
      const settings = structuredClone(f.raw.settings);
      const now = f.src.t.env.clock.now();
      if (kind === 'custom-language') entities.ownedCards[0]!.language = 'ja';
      if (kind === 'followed-settings') { settings.languages = ['en']; settings.setsFollowed = [{ language: 'ja', setId: 'tset' }, { language: 'ja', setId: 'tset' }]; }
      if (kind === 'followed-unselected') { settings.languages = ['en']; settings.setsFollowed = [{ language: 'ja', setId: 'tset' }]; }
      if (kind === 'annotation-shape' || kind === 'annotation-name') {
        entities.catalogIdentities.push({ language: 'en', id: 'tset-001', createdAt: now });
        entities.catalogAnnotations.push({
          language: 'en', catalogCardId: 'tset-001', notes: null, createdAt: now, updatedAt: now,
          displayOverrides: (kind === 'annotation-shape' ? { arbitraryUnknown: { payload: 'x' } } : { name: 42 }) as never
        });
      }
      if (kind === 'reversed-audit') { entities.ownedCards[0]!.createdAt = '2026-10-31T00:00:00.000Z'; entities.ownedCards[0]!.updatedAt = '2025-01-01T00:00:00.000Z'; }
      if (kind === 'scan-order') {
        entities.scanSessions.push({ id: f.src.t.env.ids.uuid(), status: 'closed', startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2025-01-01T00:00:00.000Z', notes: null });
      }
      const made = await buildArchive({ entities, settings, createdAt: now, appVersion: 'test', backupId: f.src.t.env.ids.uuid(), hash: f.hash });

      const target = await harness();
      open.push(target);
      const revisionBefore = await target.t.user.scalar<number>('SELECT collection_revision FROM app_state');
      const service = new BackupService(target.ctx, f.platform);
      const file = f.platform.put(`${kind}.fdx`, made.bytes);
      let error: unknown = null;
      try { await service.previewRestore({ file }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('BACKUP_INVALID');
      expect((error as DomainError).message).toMatch(reason);
      expect(await ownedCount(target)).toBe(0);
      expect(await target.t.user.scalar<number>('SELECT collection_revision FROM app_state')).toBe(revisionBefore);
    });
  }

  it('an unmodified rebuild of a valid backup still previews', async () => {
    const f = await fixture();
    const made = await buildArchive({ entities: f.raw.entities, settings: f.raw.settings, createdAt: f.src.t.env.clock.now(), appVersion: 'test', backupId: f.src.t.env.ids.uuid(), hash: f.hash });
    const target = await harness();
    open.push(target);
    const preview = await new BackupService(target.ctx, f.platform).previewRestore({ file: f.platform.put('ok.fdx', made.bytes) });
    expect(preview.totalCards).toBe(1);
  });
});
