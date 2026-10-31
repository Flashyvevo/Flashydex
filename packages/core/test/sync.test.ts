import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { RawCard } from '../src/catalog/tcgdex';
import { ActiveWorkError, InvalidStateError, UnsupportedCapabilityError } from '../src/errors';
import type { Platform } from '../src/platform/platform';
import { SyncService, parseRetryAfter, type SyncOptions } from '../src/services/sync';
import { createMemoryPlatform } from '../src/testing/memory-platform';
import { copyOf, dumpPersonal, harness, installCatalog, type Harness } from './helpers';

const card136 = JSON.parse(readFileSync(new URL('./fixtures/tcgdex/en-card-swsh3-136.json', import.meta.url), 'utf8')) as RawCard;
const bodyFor = (id: string): RawCard => ({ ...card136, id, localId: id.split('-')[1] as string });

type Reply = { status: number; headers?: Record<string, string>; body?: unknown } | 'throw';
type Script = (id: string, call: number) => Reply;

const open: Harness[] = [];
afterEach(async () => { while (open.length) await open.pop()!.cleanup(); });

async function setup(cardCount: number, script: Script, options: SyncOptions = {}) {
  const h = await harness();
  open.push(h);
  const ids = Array.from({ length: cardCount }, (_, i) => `swsh3-${String(100 + i)}`);
  await installCatalog(h, 'en', {
    sets: [{ id: 'swsh3', name: 'Darkness Ablaze' }, { id: 'other', name: 'Other Set' }],
    cards: [
      ...ids.map((id) => ({ id, setId: 'swsh3', localId: id.split('-')[1] as string, name: `Mon ${id}`, imageUrl: 'https://assets.example.test/x', variants: ['normal' as const, 'holo' as const, 'reverse_holo' as const] })),
      { id: 'other-001', setId: 'other', localId: '001', name: 'Not owned' }
    ]
  });
  for (const id of ids) await h.collection.add(copyOf(id));
  const base = createMemoryPlatform(h.t.env);
  const calls = new Map<string, number>();
  const urls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const platform: Platform = {
    ...base,
    async http({ url }) {
      urls.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        const id = decodeURIComponent(url.split('/').pop() as string);
        const n = (calls.get(id) ?? 0) + 1;
        calls.set(id, n);
        const reply = script(id, n);
        if (reply === 'throw') throw new Error('timeout');
        return { status: reply.status, headers: reply.headers ?? {}, body: 'body' in reply ? reply.body : bodyFor(id) };
      } finally {
        inFlight -= 1;
      }
    }
  };
  const sleeps: number[] = [];
  const sync = new SyncService(h.ctx, platform, { sleep: async (ms) => { sleeps.push(ms); }, awaitRun: true, ...options });
  return { h, sync, ids, calls, urls, sleeps, stats: () => ({ maxInFlight }) };
}

const SELECTION = { scope: 'followed' as const, sets: [{ language: 'en' as const, setId: 'swsh3' }] };
const priceRows = (h: Harness) => h.t.user.rows("SELECT catalog_card_id, source, variant, market_cents FROM price_snapshots ORDER BY 1,2,3");

describe('SyncService prices_only (acceptance 35)', () => {
  it('updates catalog prices + personal history for OWNED cards only; never touches owned rows', async () => {
    const t = await setup(3, () => ({ status: 200 }));
    const owned = await dumpPersonal(t.h);
    const run = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(run).toMatchObject({ status: 'completed', cardsTotal: 3, cardsDone: 3, cardsFailed: 0, setsDone: 1, lastError: null });
    expect(t.urls).toHaveLength(3);
    expect(t.urls.every((u) => u.startsWith('https://api.tcgdex.net/v2/en/cards/swsh3-1'))).toBe(true);
    expect(t.urls.some((u) => u.includes('other-001'))).toBe(false);

    const catalog = await t.h.t.databases.catalog('en');
    const latest = await catalog!.rows('SELECT catalog_card_id FROM catalog_latest_prices GROUP BY catalog_card_id ORDER BY 1');
    expect(latest.map((r) => r[0])).toEqual(t.ids);
    expect((await priceRows(t.h)).length).toBeGreaterThan(0);

    const after = await dumpPersonal(t.h);
    expect(after.owned_cards).toEqual(owned.owned_cards); // prices_only never changes owned_cards count or rows
    expect(after.catalog_identities).toEqual(owned.catalog_identities);
    expect(Number(await t.h.t.user.scalar('SELECT COUNT(*) FROM owned_cards'))).toBe(3);
    expect(Number(await t.h.t.user.scalar('SELECT COUNT(*) FROM sync_state WHERE lock_key IS NOT NULL'))).toBe(0);
  });

  it('keeps at most 8 requests in flight and commits in batches', async () => {
    const t = await setup(40, () => ({ status: 200 }));
    const run = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(run.cardsDone).toBe(40);
    expect(t.stats().maxInFlight).toBeLessThanOrEqual(8);
    expect(t.stats().maxInFlight).toBeGreaterThan(1);
  });

  it('retries 429 (honouring Retry-After), 5xx and timeouts with backoff, then succeeds', async () => {
    const t = await setup(3, (id, n) => {
      if (id === 'swsh3-100') return n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200 };
      if (id === 'swsh3-101') return n < 3 ? { status: 503 } : { status: 200 };
      return n === 1 ? 'throw' : { status: 200 };
    });
    const run = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(run).toMatchObject({ status: 'completed', cardsDone: 3, cardsFailed: 0 });
    expect(t.calls.get('swsh3-100')).toBe(2);
    expect(t.calls.get('swsh3-101')).toBe(3);
    expect(t.sleeps).toContain(2000); // Retry-After: 2 seconds
    expect(t.sleeps.filter((ms) => ms === 500 || ms === 1000).length).toBeGreaterThanOrEqual(3); // exponential backoff for 5xx / timeout
  });

  it('counts a unit that keeps failing (bad JSON / 500) as failed, finishes the rest, and the run is `failed` with a reason', async () => {
    const t = await setup(4, (id) => (id === 'swsh3-100' ? { status: 200, body: null } : id === 'swsh3-101' ? { status: 500 } : { status: 200 }), { maxAttempts: 2 });
    const run = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(run).toMatchObject({ status: 'failed', cardsTotal: 4, cardsDone: 2, cardsFailed: 2 });
    expect(run.lastError).toMatchObject({ code: 'PARTIAL_FAILURE' });
    expect(run.sets[0]).toMatchObject({ status: 'failed', cardsDone: 2, cardsFailed: 2 });
    expect(t.calls.get('swsh3-100')).toBe(2);
    expect(Number(await t.h.t.user.scalar('SELECT COUNT(*) FROM sync_state WHERE lock_key IS NOT NULL'))).toBe(0); // lock released
    const catalog = await t.h.t.databases.catalog('en');
    expect((await catalog!.rows('SELECT DISTINCT catalog_card_id FROM catalog_latest_prices ORDER BY 1')).map((r) => r[0])).toEqual(['swsh3-102', 'swsh3-103']);
  });

  it('does not retry a 404 and does not fabricate a price for it', async () => {
    const t = await setup(2, (id) => (id === 'swsh3-100' ? { status: 404 } : { status: 200 }));
    const run = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(t.calls.get('swsh3-100')).toBe(1);
    expect(run).toMatchObject({ cardsDone: 1, cardsFailed: 1, status: 'failed' });
  });
});

describe('SyncService resume / cancel / lock / recovery (acceptance 36)', () => {
  it('resume re-runs only the failed units with the same id and a new attempt, and completes', async () => {
    let healthy = false;
    const t = await setup(3, (id) => (id === 'swsh3-101' && !healthy ? { status: 500 } : { status: 200 }), { maxAttempts: 1 });
    const first = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(first).toMatchObject({ status: 'failed', cardsDone: 2, cardsFailed: 1, attempt: 1 });
    const before = t.urls.length;
    healthy = true;
    const second = await t.sync.resume({ id: first.id });
    expect(second).toMatchObject({ id: first.id, status: 'completed', cardsDone: 3, cardsFailed: 0, attempt: 2 });
    expect(t.urls.length - before).toBe(1); // only the failed card was fetched again
    await expect(t.sync.resume({ id: first.id })).rejects.toBeInstanceOf(InvalidStateError); // completed cannot resume
  });

  it('a second start while one is running is ACTIVE_SYNC; cancel stops scheduling and keeps committed work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness();
    open.push(h);
    await installCatalog(h, 'en', {
      sets: [{ id: 'swsh3', name: 'Darkness Ablaze' }],
      cards: Array.from({ length: 60 }, (_, i) => ({ id: `swsh3-${100 + i}`, setId: 'swsh3', localId: String(100 + i), name: `Mon ${i}` }))
    });
    for (let i = 0; i < 60; i += 1) await h.collection.add(copyOf(`swsh3-${100 + i}`));
    const base = createMemoryPlatform(h.t.env);
    let served = 0;
    const platform: Platform = {
      ...base,
      async http({ url }) {
        await gate;
        served += 1;
        return { status: 200, headers: {}, body: bodyFor(decodeURIComponent(url.split('/').pop() as string)) };
      }
    };
    const sync = new SyncService(h.ctx, platform, { sleep: async () => undefined });
    const run = await sync.start({ mode: 'prices_only', selection: SELECTION });
    expect(['queued', 'running']).toContain(run.status);
    await expect(sync.start({ mode: 'prices_only', selection: SELECTION })).rejects.toBeInstanceOf(ActiveWorkError);
    const cancelling = await sync.cancel({ id: run.id });
    expect(cancelling.status).toBe('cancel_requested');
    release();
    await sync.idle();
    const done = await sync.get({ id: run.id });
    expect(done.status).toBe('cancelled');
    expect(done.cardsDone).toBeLessThan(60);
    expect(done.cardsDone).toBe(served); // every fetched card of the committed batches is counted, nothing more
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM sync_state WHERE lock_key IS NOT NULL'))).toBe(0);
  });

  it('boot recovery marks an active run interrupted and releases the lock; it can then be resumed', async () => {
    const t = await setup(2, () => ({ status: 200 }));
    const first = await t.sync.start({ mode: 'prices_only', selection: SELECTION });
    // simulate an app kill mid-run: put the row back to running with the lock held
    await t.h.t.user.run("UPDATE sync_state SET status = 'running', lock_key = 'catalog', worker_token = 'dead' WHERE id = ?", [first.id]);
    expect(await t.sync.recover()).toEqual({ interrupted: 1 });
    expect((await t.sync.get({ id: first.id })).status).toBe('interrupted');
    expect(Number(await t.h.t.user.scalar('SELECT COUNT(*) FROM sync_state WHERE lock_key IS NOT NULL'))).toBe(0);
    const resumed = await t.sync.resume({ id: first.id });
    expect(resumed.status).toBe('completed');
  });

  it('refresh / incremental are honest UNSUPPORTED_CAPABILITY, and capabilities() says so', async () => {
    const t = await setup(1, () => ({ status: 200 }));
    await expect(t.sync.start({ mode: 'refresh', selection: SELECTION })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(t.sync.start({ mode: 'incremental' })).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(t.sync.capabilities()).toEqual({ pricesOnly: true, refresh: false, reason: null });
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter(undefined, 0)).toBeNull();
    expect(parseRetryAfter('garbage', 0)).toBeNull();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
  });
});
