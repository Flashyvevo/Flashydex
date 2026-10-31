import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup/backup-service';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, installStandardCatalog, ownedCount, type Harness } from './helpers';

/** F01 (Sol review 4): CatalogRepo reads that combine catalog + personal data come from one personal snapshot, or retry then STALE_READ. */
const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup() {
  const h = await harness();
  open.push(h);
  await installStandardCatalog(h);
  const first = await h.collection.add(copyOf('tset-001'));
  const user = h.t.databases.user;
  const scalar = user.scalar.bind(user);
  const state: { when: 'always' | 'once'; action: (() => Promise<unknown>) | null; fired: number } = { when: 'once', action: null, fired: 0 };
  let busy = false;
  // Fire the interleaving right AFTER the card-detail owned COUNT returns, before the copy-ID select.
  user.scalar = (async (sql: string, params?: readonly unknown[]) => {
    const out = await scalar(sql, params);
    if (!busy && state.action && sql.includes('COUNT(*) FROM owned_cards') && (state.when === 'always' || state.fired === 0)) {
      busy = true;
      try { state.fired += 1; await state.action(); } finally { busy = false; }
    }
    return out;
  }) as typeof user.scalar;
  return { h, first, state };
}
const q = { language: 'en' as const, cardId: 'tset-001' };

describe('F01 getCard consistent personal read', () => {
  it("Sol's interleaving: sole copy deleted after COUNT, before copy-ID select -> coherent (0 owned, 0 copies, hasMore false)", async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.remove({ id: s.first.id });
    const card = await s.h.catalog.getCard(q);
    expect(s.state.fired).toBe(1);
    expect(await ownedCount(s.h)).toBe(0);
    expect(card.ownedCount).toBe(0);
    expect(card.ownedCopies.data).toHaveLength(0);
    expect(card.ownedCopies.page).toMatchObject({ total: 0, hasMore: false });
  });

  it('a copy ADDED in the gap -> ownedCount == returned copies == total', async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.add(copyOf('tset-001'));
    const card = await s.h.catalog.getCard(q);
    expect(s.state.fired).toBe(1);
    expect(card.ownedCount).toBe(2);
    expect(card.ownedCopies.data).toHaveLength(2);
    expect(card.ownedCopies.page).toMatchObject({ total: 2, hasMore: false });
  });

  it('a copy UPDATED in the gap -> the returned copy reflects the update', async () => {
    const s = await setup();
    s.state.action = () => s.h.collection.update({ id: s.first.id, patch: { condition: 'LP' } });
    const card = await s.h.catalog.getCard(q);
    expect(s.state.fired).toBe(1);
    expect(card.ownedCount).toBe(1);
    expect(card.ownedCopies.data[0]).toMatchObject({ id: s.first.id, condition: 'LP' });
  });

  it('an actual BackupService.restore (empty backup) in the gap -> coherent snapshot', async () => {
    const s = await setup();
    const src = await harness();
    open.push(src);
    await installStandardCatalog(src);
    const platform = createMemoryPlatform(src.t.env);
    const created = await new BackupService(src.ctx, platform).create({});
    const service = new BackupService(s.h.ctx, platform);
    const preview = await service.previewRestore({ file: created.file });
    s.state.action = () => service.restore({ id: preview.id, backupHash: preview.backupHash, userStateToken: preview.userStateToken, confirm: 'RESTORE' });
    const card = await s.h.catalog.getCard(q);
    expect(s.state.fired).toBe(1);
    expect(await ownedCount(s.h)).toBe(0);
    expect(card.ownedCount).toBe(0);
    expect(card.ownedCopies.data).toHaveLength(0);
    expect(card.ownedCopies.page.hasMore).toBe(false);
  });

  it('a write on EVERY attempt never yields a mixed answer: typed STALE_READ', async () => {
    const s = await setup();
    s.state.when = 'always';
    s.state.action = () => s.h.collection.add(copyOf('tset-001'));
    await expect(s.h.catalog.getCard(q)).rejects.toMatchObject({ code: 'STALE_READ' });
  });

  it('without interleaving getCard is unchanged', async () => {
    const s = await setup();
    const card = await s.h.catalog.getCard(q);
    expect(card.ownedCount).toBe(1);
    expect(card.ownedCopies.data).toHaveLength(1);
  });
});

describe('F01 set reads use the same consistent read', () => {
  it('getSet / listSets / listSetCards: an add between catalog read and owned stats yields STALE_READ when it repeats, else a coherent result', async () => {
    const s = await setup();
    const user = s.h.t.databases.user;
    const rows = user.rows.bind(user);
    let fired = 0;
    let busy = false;
    user.rows = (async (sql: string, params?: readonly unknown[]) => {
      const out = await rows(sql, params);
      if (!busy && fired === 0 && sql.includes('FROM owned_cards')) {
        busy = true; fired += 1;
        try { await s.h.collection.add(copyOf('tset-002')); } finally { busy = false; }
      }
      return out;
    }) as typeof user.rows;
    const set = await s.h.catalog.getSet({ language: 'en', setId: 'tset' });
    expect(fired).toBe(1);
    expect(set.ownedCount).toBe(2);
    expect(set.ownedUnique).toBe(2);
    const list = await s.h.catalog.listSetCards({ language: 'en', setId: 'tset', ownership: 'owned', offset: 0, limit: 50 } as never);
    expect(list.data.map((c) => c.id).sort()).toEqual(['tset-001', 'tset-002']);
  });
});
