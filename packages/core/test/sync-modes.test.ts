import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawCard } from '../src/catalog/tcgdex';
import type { Platform } from '../src/platform/platform';
import { CatalogInstallService } from '../src/services/catalog-install';
import { SyncService, type SyncOptions } from '../src/services/sync';
import { FakeDiskPort, KillSignal } from '../src/testing/fake-install-port';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, dumpPersonal, harness, harnessFor, installCatalog, revision, type Harness } from './helpers';

/** R07 (refresh, incremental, exact pending-batch replay) + R10 (admission, fencing) for SyncService. Synthetic upstream, TESTS ONLY. */
const card136 = JSON.parse(readFileSync(new URL('./fixtures/tcgdex/en-card-swsh3-136.json', import.meta.url), 'utf8')) as RawCard;
const API = 'https://api.tcgdex.net/v2';
const cardBody = (id: string, market = 0.27): RawCard => {
  const body = JSON.parse(JSON.stringify({ ...card136, id, localId: id.split('-')[1] as string, name: `Mon ${id}`, set: { ...card136.set, id: id.split('-')[0] as string } })) as RawCard & { variants_detailed: Array<{ pricing: { tcgplayer: { normal: { marketPrice: number } } } }> };
  body.variants_detailed[0]!.pricing.tcgplayer.normal.marketPrice = market;
  return body;
};
const setBody = (id: string, name: string, cards: string[], total = cards.length) => ({
  id, name, serie: { id: 'swsh', name: 'Sword & Shield' }, releaseDate: '2020-08-14', cardCount: { total, official: total },
  cards: cards.map((c) => ({ id: c, localId: c.split('-')[1], name: `Mon ${c}` }))
});

class Upstream {
  sets = new Map<string, ReturnType<typeof setBody>>();
  cards = new Map<string, RawCard>();
  list: Array<Record<string, unknown>> = [];
  requests: string[] = [];
  gate: Promise<void> | null = null;
  market = 0.27;
  add(set: ReturnType<typeof setBody>, market = this.market) {
    this.sets.set(set.id, set);
    for (const c of set.cards) this.cards.set(c.id, cardBody(c.id, market));
    this.list = [...this.sets.values()].map((s) => ({ id: s.id, name: s.name, cardCount: s.cardCount }));
  }
  reprice(market: number) {
    this.market = market;
    for (const id of this.cards.keys()) this.cards.set(id, cardBody(id, market));
  }
  platform(base: Platform): Platform {
    return {
      ...base,
      http: async ({ url }) => {
        this.requests.push(url);
        if (this.gate) await this.gate;
        const path = url.slice(API.length + 1).split('/').map(decodeURIComponent);
        const [, kind, id] = path;
        if (kind === 'sets' && id === undefined) return { status: 200, headers: {}, body: this.list };
        if (kind === 'sets') { const s = this.sets.get(id as string); return s ? { status: 200, headers: {}, body: s } : { status: 404, headers: {}, body: null }; }
        if (kind === 'cards') { const c = this.cards.get(id as string); return c ? { status: 200, headers: {}, body: c } : { status: 404, headers: {}, body: null }; }
        return { status: 404, headers: {}, body: null };
      }
    };
  }
  count(fragment: string): number {
    return this.requests.filter((u) => u.includes(fragment)).length;
  }
}

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup(options: SyncOptions = {}) {
  const h = await harness();
  open.push(h);
  await installCatalog(h, 'en', {
    sets: [
      { id: 'swsh3', name: 'Darkness Ablaze', series: 'swsh', officialCount: 1, totalCount: 1 },
      { id: 'other', name: 'Other Set', series: 'swsh', officialCount: 1, totalCount: 1 },
      { id: 'shell1', name: 'Future Shell', series: 'swsh', status: 'unpublished', manifest: [], officialCount: 0, totalCount: 0 }
    ],
    cards: [
      { id: 'swsh3-100', setId: 'swsh3', localId: '100', name: 'Old Mon swsh3-100', variants: ['normal'] },
      { id: 'other-001', setId: 'other', localId: '001', name: 'Other Mon' }
    ]
  });
  await h.collection.add(copyOf('swsh3-100'));
  const up = new Upstream();
  up.add(setBody('swsh3', 'Darkness Ablaze', ['swsh3-100', 'swsh3-101', 'swsh3-102'], 3));
  up.add(setBody('other', 'Other Set', ['other-001'], 1));
  up.add(setBody('shell1', 'Future Shell', [], 0));
  const base = createMemoryPlatform(h.t.env);
  const platform = up.platform(base);
  const mk = (hh: Harness, extra: SyncOptions = {}) => new SyncService(hh.ctx, platform, { sleep: async () => undefined, awaitRun: true, ...options, ...extra });
  return { h, up, platform, sync: mk(h), mk };
}
const REFRESH = (setId = 'swsh3') => ({ mode: 'refresh' as const, selection: { scope: 'followed' as const, sets: [{ language: 'en' as const, setId }] } });
const catRows = async (h: Harness, sql: string, params: unknown[] = []) => (await (await h.t.databases.catalog('en'))!.rows(sql, params));
const market = async (h: Harness, id: string) => ({
  catalog: (await catRows(h, "SELECT market_cents FROM catalog_latest_prices WHERE catalog_card_id = ? AND source = 'tcgplayer' AND variant = 'normal'", [id])).map((r) => r[0]),
  history: (await h.t.user.rows("SELECT market_cents FROM price_snapshots WHERE catalog_card_id = ? AND source = 'tcgplayer' AND variant = 'normal' ORDER BY market_cents", [id])).map((r) => r[0])
});
const kill = (h: Harness, where: string) => () => { h.t.user.setMaintenance(true); throw new KillSignal(where); };

describe('R07 capabilities', () => {
  it('all three modes are reported when the catalog source is writable; honest false + reason otherwise', async () => {
    const t = await setup();
    expect(t.sync.capabilities()).toEqual({ pricesOnly: true, refresh: true, incremental: true, reason: null });
    (t.h.t.databases as unknown as { source: { writable: boolean } }).source.writable = false;
    expect(t.sync.capabilities()).toMatchObject({ pricesOnly: false, refresh: false, incremental: false, reason: expect.any(String) });
    await expect(t.sync.start(REFRESH())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(t.sync.start({ mode: 'incremental' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});

describe('R07 refresh (single-set fill-in)', () => {
  it('fills in the whole set into the installed catalog, touches nothing else, keeps owned rows and revision', async () => {
    const t = await setup();
    const owned = await dumpPersonal(t.h);
    const rev = await revision(t.h);
    const otherBefore = await catRows(t.h, "SELECT * FROM catalog_cards WHERE set_id = 'other'");
    const run = await t.sync.start(REFRESH());
    expect(run).toMatchObject({ mode: 'refresh', status: 'completed', setsTotal: 1, setsDone: 1, cardsTotal: 3, cardsDone: 3, cardsFailed: 0, lastError: null });
    expect((await catRows(t.h, "SELECT id FROM catalog_cards WHERE set_id = 'swsh3' ORDER BY id")).map((r) => r[0])).toEqual(['swsh3-100', 'swsh3-101', 'swsh3-102']);
    expect(await catRows(t.h, "SELECT name FROM catalog_cards WHERE id = 'swsh3-100'")).toEqual([['Mon swsh3-100']]); // refreshed, authoritative for that card
    expect(Number((await catRows(t.h, "SELECT COUNT(*) FROM catalog_variants WHERE card_id = 'swsh3-101'"))[0]![0])).toBeGreaterThan(0);
    expect(await catRows(t.h, "SELECT official_count, total_count FROM catalog_sets WHERE id = 'swsh3'")).toEqual([[3, 3]]);
    expect(await catRows(t.h, "SELECT * FROM catalog_cards WHERE set_id = 'other'")).toEqual(otherBefore);
    expect(t.up.count('/cards/other-')).toBe(0);
    expect(await dumpPersonal(t.h)).toEqual({ ...owned, price_snapshots: expect.any(Array) });
    expect(await revision(t.h)).toBe(rev);
    expect((await market(t.h, 'swsh3-100')).history).toEqual([27]); // history only for the owned identity
    expect((await t.h.t.user.rows('SELECT COUNT(*) FROM price_snapshots WHERE catalog_card_id = ?', ['swsh3-101']))[0]).toEqual([0]);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]); // admission released
  });

  it('unpublished shell recheck: the shell becomes published once upstream lists cards', async () => {
    const t = await setup();
    t.up.add(setBody('shell1', 'Future Shell', ['shell1-001', 'shell1-002'], 2));
    const run = await t.sync.start(REFRESH('shell1'));
    expect(run).toMatchObject({ status: 'completed', cardsTotal: 2, cardsDone: 2 });
    expect(await catRows(t.h, "SELECT status, official_count FROM catalog_sets WHERE id = 'shell1'")).toEqual([['published', 2]]);
    expect(Number((await catRows(t.h, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'shell1'"))[0]![0])).toBe(2);
  });

  it('a shell that is still empty upstream just gets its set row re-checked', async () => {
    const t = await setup();
    const run = await t.sync.start(REFRESH('shell1'));
    expect(run).toMatchObject({ status: 'completed', cardsTotal: 0 });
    expect(await catRows(t.h, "SELECT status FROM catalog_sets WHERE id = 'shell1'")).toEqual([['unpublished']]);
  });

  it('CATALOG_NOT_INSTALLED when that language has no catalog; nothing is written or admitted', async () => {
    const t = await setup();
    await expect(t.sync.start({ mode: 'refresh', selection: { scope: 'followed', sets: [{ language: 'ja', setId: 'x' }] } })).rejects.toMatchObject({ code: 'CATALOG_NOT_INSTALLED' });
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM sync_state')).toEqual([[0]]);
  });

  it('a set that 404s upstream is a failed set with a warning, and does not abort the other sets', async () => {
    const t = await setup();
    const run = await t.sync.start({ mode: 'refresh', selection: { scope: 'followed', sets: [{ language: 'en', setId: 'nope' }, { language: 'en', setId: 'other' }] } });
    expect(run.sets.map((s) => [s.setId, s.status])).toEqual([['nope', 'failed'], ['other', 'done']]);
    expect(run.warnings[0]).toMatchObject({ code: 'SET_NOT_FOUND', language: 'en' });
  });
});

describe('R07 incremental', () => {
  it('discovery refreshes new / unpublished / changed sets and skips unchanged ones without card requests', async () => {
    const t = await setup();
    t.up.add(setBody('newset', 'Brand New', ['newset-001', 'newset-002'], 2));
    t.up.add(setBody('shell1', 'Future Shell', ['shell1-001'], 1));
    // swsh3 grew (1 -> 3 cards); `other` is unchanged (name, total and official equal to the catalog row)
    const run = await t.sync.start({ mode: 'incremental' });
    expect(run).toMatchObject({ mode: 'incremental', status: 'completed', setsTotal: 4, setsDone: 4, cardsFailed: 0 });
    expect(Object.fromEntries(run.sets.map((s) => [s.setId, s.status]))).toEqual({ newset: 'done', other: 'done', shell1: 'done', swsh3: 'done' });
    expect(t.up.count('/cards/other-')).toBe(0); // unchanged set: no card request
    expect(t.up.count('/cards/newset-')).toBe(2);
    expect(t.up.count('/cards/swsh3-')).toBe(3);
    expect(await catRows(t.h, "SELECT id, status FROM catalog_sets ORDER BY id")).toEqual([['newset', 'published'], ['other', 'published'], ['shell1', 'published'], ['swsh3', 'published']]);
    expect(Number((await catRows(t.h, 'SELECT COUNT(*) FROM catalog_cards'))[0]![0])).toBe(3 + 2 + 1 + 1);
  });

  it('followed incremental only looks at the selected sets; languages without a catalog are skipped with a warning', async () => {
    const t = await setup();
    t.up.add(setBody('newset', 'Brand New', ['newset-001'], 1));
    const run = await t.sync.start({ mode: 'incremental', languages: ['en', 'ja'] });
    expect(run.warnings).toEqual([expect.objectContaining({ code: 'CATALOG_NOT_INSTALLED', language: 'ja' })]);
    const followed = await t.sync.start({ mode: 'incremental', selection: { scope: 'followed', sets: [{ language: 'en', setId: 'shell1' }] } });
    expect(followed.sets.map((s) => s.setId)).toEqual(['shell1']);
  });

  it('discovery is frozen: a killed run resumes without listing the sets again', async () => {
    const t = await setup({ batchSize: 1 });
    let n = 0;
    const h = t.h;
    const dying = t.mk(h, { faultAfterCatalogCommit: () => { n += 1; if (n === 1) kill(h, 'incremental')(); } });
    await dying.start({ mode: 'incremental' });
    const listCalls = t.up.requests.filter((u) => u.endsWith('/en/sets')).length;
    expect(listCalls).toBe(1);
    const h2 = harnessFor(await h.t.reopen());
    open.push(h2);
    const s2 = t.mk(h2);
    await s2.recover();
    const id = (await s2.list({ offset: 0, limit: 5 })).data[0]!.id;
    const done = await s2.resume({ id });
    expect(done.status).toBe('completed');
    expect(t.up.requests.filter((u) => u.endsWith('/en/sets')).length).toBe(1);
    expect(Number((await catRows(h2, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'swsh3'"))[0]![0])).toBe(3);
  });
});

describe('R07 exact pending-batch replay across a kill between the CATALOG and USER commits', () => {
  for (const mode of ['prices_only', 'refresh'] as const) {
    it(`${mode}: the FIRST observation wins even though the upstream response CHANGED before the resume`, async () => {
      const t = await setup();
      const h = t.h;
      const dying = t.mk(h, { faultAfterCatalogCommit: kill(h, 'between commits') });
      const sel = mode === 'refresh' ? REFRESH() : { mode: 'prices_only' as const, selection: { scope: 'followed' as const, sets: [{ language: 'en' as const, setId: 'swsh3' }] } };
      await dying.start(sel);
      // catalog committed with the first observation, user checkpoint NOT cleared
      expect((await market(h, 'swsh3-100')).catalog).toEqual([27]);
      expect((await market(h, 'swsh3-100')).history).toEqual([]);

      t.up.reprice(9.99); // upstream moved on while the app was dead
      t.up.requests.length = 0;
      const h2 = harnessFor(await h.t.reopen());
      open.push(h2);
      const s2 = t.mk(h2);
      expect(await s2.recover()).toEqual({ interrupted: 1 });
      expect(await h2.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
      const id = (await s2.list({ offset: 0, limit: 5 })).data[0]!.id;
      const done = await s2.resume({ id });
      expect(done).toMatchObject({ status: 'completed', cardsFailed: 0 });
      expect(t.up.count('/cards/swsh3-100')).toBe(0); // replayed from the stored payload, not refetched
      expect(await market(h2, 'swsh3-100')).toEqual({ catalog: [27], history: [27] }); // first observation only; 9.99 never appears for this batch
      const cp = JSON.parse(String((await h2.t.user.rows('SELECT checkpoint_json FROM sync_state'))[0]![0])) as { pendingBatch: unknown };
      expect(cp.pendingBatch).toBeNull();
      expect(done.warnings.some((w) => w.code === 'BATCH_DISCARDED')).toBe(false);
    });
  }

  it('a kill BEFORE the pending batch is committed refetches (the first observation was never captured)', async () => {
    const t = await setup();
    const h = t.h;
    const dying = t.mk(h, { faultBeforePendingCommit: kill(h, 'before pending') });
    await dying.start({ mode: 'prices_only', selection: { scope: 'followed', sets: [{ language: 'en', setId: 'swsh3' }] } });
    expect((await market(h, 'swsh3-100')).catalog).toEqual([]); // nothing durable
    t.up.reprice(9.99);
    const h2 = harnessFor(await h.t.reopen());
    open.push(h2);
    const s2 = t.mk(h2);
    await s2.recover();
    const id = (await s2.list({ offset: 0, limit: 5 })).data[0]!.id;
    await s2.resume({ id });
    expect(await market(h2, 'swsh3-100')).toEqual({ catalog: [999], history: [999] });
  });

  it('a kill after the pending commit but BEFORE the catalog write also replays exactly', async () => {
    const t = await setup();
    const h = t.h;
    const dying = t.mk(h, { faultAfterPendingCommit: kill(h, 'after pending') });
    await dying.start(REFRESH());
    expect(await catRows(h, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'swsh3'")).toEqual([[1]]);
    t.up.reprice(9.99);
    const h2 = harnessFor(await h.t.reopen());
    open.push(h2);
    const s2 = t.mk(h2);
    await s2.recover();
    await s2.resume({ id: (await s2.list({ offset: 0, limit: 5 })).data[0]!.id });
    expect(await catRows(h2, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'swsh3'")).toEqual([[3]]);
    expect((await market(h2, 'swsh3-100')).catalog).toEqual([27]);
  });
});

describe('R10 admission + fencing for sync', () => {
  const installer = (h: Harness) => {
    const port = new FakeDiskPort(h.t.dir, h.t.env);
    port.manifestJson = FakeDiskPort.manifest(['ja'], '2026.10.31.001', 'a'.repeat(64));
    return { port, svc: new CatalogInstallService(h.ctx, port, { trustedOrigins: ['https://example.test'] }) };
  };
  const sig = () => new AbortController().signal;

  it('sync.start vs install.install started concurrently (sync first): exactly one wins', async () => {
    const t = await setup({ awaitRun: false });
    const { svc, port } = installer(t.h);
    let release!: () => void;
    t.up.gate = new Promise<void>((r) => { release = r; });
    const results = await Promise.allSettled([t.sync.start(REFRESH()), svc.install('ja', () => undefined, sig())]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: expect.stringMatching(/^ACTIVE_(WORK|SYNC)$/) });
    expect(port.calls).toEqual([]); // the installer never staged anything
    release();
    await t.sync.idle();
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
  });

  it('install.install vs sync.start started concurrently (install first): exactly one wins', async () => {
    const t = await setup({ awaitRun: false });
    const { svc, port } = installer(t.h);
    let release!: () => void;
    port.hold = new Promise<void>((r) => { release = r; });
    const installing = svc.install('ja', () => undefined, sig());
    const syncing = t.sync.start(REFRESH());
    await expect(syncing).rejects.toMatchObject({ code: expect.stringMatching(/^ACTIVE_(WORK|SYNC)$/) });
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM sync_state')).toEqual([[0]]);
    release();
    await expect(installing).resolves.toMatchObject({ language: 'ja', status: 'installed' });
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
  });

  it('install / uninstall / rollback during an active sync are refused; the sync still finishes', async () => {
    const t = await setup({ awaitRun: false });
    const { svc } = installer(t.h);
    let release!: () => void;
    t.up.gate = new Promise<void>((r) => { release = r; });
    await t.sync.start(REFRESH());
    await expect(svc.install('ja', () => undefined, sig())).rejects.toMatchObject({ code: expect.stringMatching(/^ACTIVE_(WORK|SYNC)$/) });
    await expect(svc.uninstall({ language: 'en', confirm: true })).rejects.toMatchObject({ code: expect.stringMatching(/^ACTIVE_(WORK|SYNC)$/) });
    await expect(svc.rollback('en')).rejects.toMatchObject({ code: expect.stringMatching(/^ACTIVE_(WORK|SYNC)$/) });
    await expect(t.sync.start(REFRESH('other'))).rejects.toMatchObject({ code: 'ACTIVE_SYNC' });
    release();
    await t.sync.idle();
    expect((await t.sync.list({ offset: 0, limit: 5 })).data[0]).toMatchObject({ status: 'completed' });
  });

  it('generation fencing: an epoch change (install/uninstall commit) between fetch and commit aborts the batch with no write', async () => {
    const t = await setup();
    const fenced = t.mk(t.h, { faultBeforePendingCommit: () => t.h.t.databases.bumpEpoch('en') });
    const before = await catRows(t.h, 'SELECT COUNT(*) FROM catalog_cards');
    const run = await fenced.start(REFRESH());
    expect(run).toMatchObject({ status: 'failed', lastError: { code: 'STALE_READ' } });
    expect(await catRows(t.h, 'SELECT COUNT(*) FROM catalog_cards')).toEqual(before);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM price_snapshots')).toEqual([[0]]);
    expect(await t.h.t.user.rows('SELECT COUNT(*) FROM work_admission')).toEqual([[0]]);
  });

  it('fencing inside the catalog write: epoch bumped after the pending commit -> catalog untouched; resume drops the stale batch and refetches', async () => {
    const t = await setup();
    const fenced = t.mk(t.h, { faultAfterPendingCommit: () => t.h.t.databases.bumpEpoch('en') });
    const run = await fenced.start(REFRESH());
    expect(run).toMatchObject({ status: 'failed', lastError: { code: 'STALE_READ' } });
    expect(await catRows(t.h, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'swsh3'")).toEqual([[1]]);
    const resumed = await t.sync.resume({ id: run.id });
    expect(resumed.status).toBe('completed');
    expect(resumed.warnings.some((w) => w.code === 'BATCH_DISCARDED')).toBe(true);
    expect(await catRows(t.h, "SELECT COUNT(*) FROM catalog_cards WHERE set_id = 'swsh3'")).toEqual([[3]]);
  });

  it('read/activation race: readers wait for the barrier and never reopen a half-swapped catalog; a long barrier yields MAINTENANCE', async () => {
    const t = await setup();
    const db = t.h.t.databases;
    let opens = 0;
    const source = (db as unknown as { source: { open: (l: 'en' | 'ja') => Promise<unknown> } }).source;
    const original = source.open.bind(source);
    source.open = async (l) => { opens += 1; return original(l); };
    await db.catalog('en'); // warm
    opens = 0;
    let observed: { held: boolean; opensDuringBarrier: number; read: Promise<unknown> } | null = null;
    await db.withBarrier(['en'], async () => {
      await db.invalidateCatalog('en');
      const read = db.catalog('en');
      await new Promise((r) => setTimeout(r, 30));
      observed = { held: db.barrierHeld('en'), opensDuringBarrier: opens, read };
    });
    expect(observed).toMatchObject({ held: true, opensDuringBarrier: 0 }); // the reader did not reopen while the barrier was held
    expect(await (await observed!.read as { rows: (s: string) => Promise<unknown[]> }).rows('SELECT COUNT(*) FROM catalog_cards')).toEqual([[2]]);
    expect(opens).toBe(1);
    db.barrierWaitMs = 20;
    let blocked: Promise<unknown> | null = null;
    await db.withBarrier(['en'], async () => { blocked = db.catalog('en').then(() => 'opened', (e: { code: string }) => e.code); await new Promise((r) => setTimeout(r, 80)); });
    expect(await blocked).toBe('MAINTENANCE');
  });

  it('multi-domain consistent reads: retry once on a revision/epoch move, then STALE_READ', async () => {
    const t = await setup();
    const db = t.h.t.databases;
    let calls = 0;
    await expect(db.consistentRead(['en'], async () => { calls += 1; if (calls === 1) db.bumpEpoch('en'); return 'ok'; })).resolves.toBe('ok');
    expect(calls).toBe(2);
    calls = 0;
    await expect(db.consistentRead(['en'], async () => { calls += 1; await t.h.collection.add(copyOf('other-001')); return 'never'; })).rejects.toMatchObject({ code: 'STALE_READ' });
    expect(calls).toBe(2);
  });
});
