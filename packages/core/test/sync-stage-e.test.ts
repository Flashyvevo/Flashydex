import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawCard } from '../src/catalog/tcgdex';
import type { Platform } from '../src/platform/platform';
import { CatalogInstallService } from '../src/services/catalog-install';
import { SyncService, type SyncOptions } from '../src/services/sync';
import { FakeDiskPort } from '../src/testing/fake-install-port';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, harness, harnessFor, installCatalog, type Harness } from './helpers';

/** Stage E: N02 (pending batches fence on a PERSISTED installed-content identity) and N06 (sync terminal status). Synthetic upstream, TESTS ONLY. */
const card136 = JSON.parse(readFileSync(new URL('./fixtures/tcgdex/en-card-swsh3-136.json', import.meta.url), 'utf8')) as RawCard;
const CFG = { trustedOrigins: ['https://example.test'] };
const noop = () => undefined;
const sig = () => new AbortController().signal;

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });
const track = (h: Harness): Harness => { open.push(h); return h; };

const priceCard = (id: string, setId: string, market: number): RawCard => {
  const body = JSON.parse(JSON.stringify({ ...card136, id, localId: id.split('-')[1] as string, name: `Mon ${id}`, set: { ...card136.set, id: setId } })) as RawCard & {
    variants_detailed: Array<{ pricing: { tcgplayer: { normal: { marketPrice: number } } } }>;
  };
  body.variants_detailed[0]!.pricing.tcgplayer.normal.marketPrice = market;
  return body;
};

describe('N02 persisted installed-content identity fences pending batches (real CatalogInstallService, cold reopen)', () => {
  async function scenario() {
    const h0 = track(await harness());
    const port = new FakeDiskPort(h0.t.dir, h0.t.env);
    port.manifestJson = FakeDiskPort.manifest(['en']);
    await new CatalogInstallService(h0.ctx, port, CFG).install('en', noop, sig());
    await h0.collection.add(copyOf('tset-001'));
    let price = 0.27;
    let calls = 0;
    const platform: Platform = {
      ...createMemoryPlatform(h0.t.env),
      http: async ({ url }) => {
        calls += 1;
        if (!url.includes('/cards/')) return { status: 404, headers: {}, body: null };
        return { status: 200, headers: {}, body: priceCard('tset-001', 'tset', price) };
      }
    };
    const dying = new SyncService(h0.ctx, platform, {
      awaitRun: true, sleep: async () => undefined,
      faultAfterCatalogCommit: () => { h0.t.user.setMaintenance(true); throw new Error('killed between the catalog commit and the user commit'); }
    });
    const run = await dying.start({ mode: 'prices_only', selection: { scope: 'followed', sets: [{ language: 'en', setId: 'tset' }] } });
    const oldEpoch = h0.t.databases.epoch('en');
    port.revive();
    const reopen = async (options: SyncOptions = {}) => {
      const h = track(harnessFor(await (open[open.length - 1] as Harness).t.reopen()));
      return { h, sync: new SyncService(h.ctx, platform, { awaitRun: true, sleep: async () => undefined, ...options }) };
    };
    return { h0, port, run, oldEpoch, reopen, setPrice: (p: number) => { price = p; calls = 0; }, calls: () => calls };
  }
  const marketCents = async (h: Harness) => h.t.user.rows("SELECT market_cents FROM price_snapshots WHERE source='tcgplayer' AND variant='normal'");

  it('kill between the pending commit and the catalog commit -> cold reopen -> changed upstream: the FIRST observation (27) wins, nothing refetched', async () => {
    const s = await scenario();
    expect(s.oldEpoch).toBeGreaterThan(0); // a real install, not an epoch-zero fixture
    s.setPrice(9.99);
    const { h, sync } = await s.reopen();
    expect(h.t.databases.epoch('en')).toBe(0); // the in-process counter did NOT survive the restart
    await sync.recover();
    const done = await sync.resume({ id: s.run.id });
    expect(done.warnings.some((w) => w.code === 'BATCH_DISCARDED')).toBe(false);
    expect(done.status).toBe('completed');
    expect(s.calls()).toBe(0);
    expect(await marketCents(h)).toEqual([[27]]);
  });

  it('install replacement between attempts (new process, SAME small epoch value): the saved batch is discarded and refetched', async () => {
    const s = await scenario();
    s.setPrice(9.99);
    const { h, sync } = await s.reopen();
    await sync.recover();
    const port2 = new FakeDiskPort(h.t.dir, h.t.env);
    port2.manifestJson = FakeDiskPort.manifest(['en'], '2026.11.01.001', 'b'.repeat(64));
    await new CatalogInstallService(h.ctx, port2, CFG).install('en', noop, sig());
    expect(h.t.databases.epoch('en')).toBe(s.oldEpoch); // same counter value as before the restart: only a persisted identity can tell
    const done = await sync.resume({ id: s.run.id });
    expect(done.warnings.some((w) => w.code === 'BATCH_DISCARDED')).toBe(true);
    expect(done.status).toBe('completed');
    expect(s.calls()).toBeGreaterThan(0);
    expect(await marketCents(h)).toEqual([[999]]);
  });

  it('uninstall + reinstall of the SAME version/sha between attempts still discards the batch (receipt generation moved)', async () => {
    const s = await scenario();
    s.setPrice(9.99);
    const { h, sync } = await s.reopen();
    await sync.recover();
    const port2 = new FakeDiskPort(h.t.dir, h.t.env);
    port2.manifestJson = FakeDiskPort.manifest(['en']);
    const svc = new CatalogInstallService(h.ctx, port2, CFG);
    await svc.uninstall({ language: 'en', confirm: true });
    await svc.install('en', noop, sig());
    const done = await sync.resume({ id: s.run.id });
    expect(done.warnings.some((w) => w.code === 'BATCH_DISCARDED')).toBe(true);
    expect(await marketCents(h)).toEqual([[999]]);
  });
});

describe('N06 a run with a failed set or discovery unit ends failed (resumable) with a lastError', () => {
  const API = 'https://api.tcgdex.net/v2';
  const setBody = (id: string, cards: string[]) => ({
    id, name: `Set ${id}`, serie: { id: 'swsh', name: 'Sword & Shield' }, releaseDate: '2020-08-14', cardCount: { total: cards.length, official: cards.length },
    cards: cards.map((c) => ({ id: c, localId: c.split('-')[1], name: `Mon ${c}` }))
  });
  async function setup() {
    const h = track(await harness());
    await installCatalog(h, 'en', {
      sets: [{ id: 'swsh3', name: 'Darkness Ablaze', series: 'swsh', officialCount: 1, totalCount: 1 }, { id: 'other', name: 'Other', series: 'swsh', officialCount: 1, totalCount: 1 }],
      cards: [{ id: 'swsh3-100', setId: 'swsh3', localId: '100', name: 'Old Mon', variants: ['normal'] }, { id: 'other-001', setId: 'other', localId: '001', name: 'Other Mon' }]
    });
    const served = new Set<string>(['other']);
    const platform: Platform = {
      ...createMemoryPlatform(h.t.env),
      http: async ({ url }) => {
        const [, kind, id] = url.slice(API.length + 1).split('/').map(decodeURIComponent);
        if (kind === 'sets' && id !== undefined) return served.has(id) ? { status: 200, headers: {}, body: setBody(id, [`${id}-001`]) } : { status: 404, headers: {}, body: null };
        if (kind === 'cards') return { status: 200, headers: {}, body: priceCard(id as string, (id as string).split('-')[0] as string, 0.27) };
        return { status: 404, headers: {}, body: null };
      }
    };
    return { h, served, sync: new SyncService(h.ctx, platform, { awaitRun: true, sleep: async () => undefined, baseDelayMs: 0 }) };
  }
  const sets = (...ids: string[]) => ({ mode: 'refresh' as const, selection: { scope: 'followed' as const, sets: ids.map((setId) => ({ language: 'en' as const, setId })) } });

  it('all-set failure (every set 404s): status failed, lastError set, resume completes once upstream serves it', async () => {
    const t = await setup();
    const run = await t.sync.start(sets('swsh3'));
    expect(run).toMatchObject({ status: 'failed', cardsFailed: 0, lastError: { code: expect.any(String), message: expect.any(String) } });
    expect(run.sets).toMatchObject([{ setId: 'swsh3', status: 'failed' }]);
    t.served.add('swsh3');
    const resumed = await t.sync.resume({ id: run.id });
    expect(resumed).toMatchObject({ status: 'completed', lastError: null });
    expect(resumed.sets).toMatchObject([{ setId: 'swsh3', status: 'done' }]);
  });

  it('mixed-set failure (one set ok, one 404): failed with lastError, the good set stays done, resume fixes only the failed one', async () => {
    const t = await setup();
    const run = await t.sync.start(sets('swsh3', 'other'));
    expect(run.status).toBe('failed');
    expect(run.lastError).not.toBeNull();
    expect(run.lastError?.message).toMatch(/1 set/);
    expect(run.sets.map((s) => [s.setId, s.status])).toEqual([['swsh3', 'failed'], ['other', 'done']]);
    t.served.add('swsh3');
    const resumed = await t.sync.resume({ id: run.id });
    expect(resumed.status).toBe('completed');
    expect(resumed.sets.map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('incremental: a discovered set whose detail 404s fails the run (not completed)', async () => {
    const t = await setup();
    const platformList: Platform = {
      ...createMemoryPlatform(t.h.t.env),
      http: async ({ url }) => {
        const [, kind, id] = url.slice(API.length + 1).split('/').map(decodeURIComponent);
        if (kind === 'sets' && id === undefined) return { status: 200, headers: {}, body: [{ id: 'brandnew', name: 'Brand New', cardCount: { total: 1, official: 1 } }] };
        return { status: 404, headers: {}, body: null };
      }
    };
    const inc = new SyncService(t.h.ctx, platformList, { awaitRun: true, sleep: async () => undefined, baseDelayMs: 0 });
    const run = await inc.start({ mode: 'incremental' });
    expect(run.status).toBe('failed');
    expect(run.lastError).not.toBeNull();
  });
});
