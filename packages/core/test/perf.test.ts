import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureCard, FixtureSet } from '../src/testing/catalog-fixture';
import { copyOf, harness, installCatalog, type Harness } from './helpers';

/**
 * C16 / R12: search over a 40,000-row synthetic catalog and the collection grid over 10,000 owned copies (giant groups AND many groups),
 * each measured with 10 warm-ups + 100 samples and reported as p50 / p95 / max; the budget is asserted on p95.
 * These are NODE-ONLY numbers (better-sqlite3, no bridge, no WebView): they do not claim device latency.
 * HEAVY: set FLASHYDEX_SKIP_PERF=1 to skip this file (it adds ~30-60 s to `npm test`).
 */
const BUDGET_MS = 300;
const WARMUPS = 10;
const SAMPLES = 100;
const SETS = 200;
const PER_SET = 200; // 40,000 cards
const BASES = ['Charizard', 'Charmander', 'Charmeleon', 'Pikachu', 'Raichu', 'Bulbasaur', 'Squirtle', 'Eevee', 'Mewtwo', 'Snorlax'];

let h: Harness;

beforeAll(async () => {
  h = await harness();
  const sets: FixtureSet[] = [];
  const cards: FixtureCard[] = [];
  for (let s = 0; s < SETS; s += 1) {
    const setId = `perf${String(s).padStart(3, '0')}`;
    sets.push({ id: setId, name: `Synthetic Set ${s}`, series: 'perf', releaseDate: '2021-01-01' });
    for (let i = 1; i <= PER_SET; i += 1) {
      const localId = String(i);
      const base = BASES[(s * PER_SET + i) % BASES.length] as string;
      cards.push({ id: `${setId}-${String(i).padStart(3, '0')}`, setId, localId, name: `${base} ${['V', 'EX', 'GX', 'ex', 'VMAX'][i % 5]} ${s}-${i}`, rarity: i % 7 === 0 ? 'Rare Holo' : 'Common', variants: ['normal', 'holo'] });
    }
  }
  expect(cards).toHaveLength(40_000);
  await installCatalog(h, 'en', { sets, cards });
}, 120_000);

afterAll(() => h?.cleanup());

export type Stats = { p50: number; p95: number; max: number };

/** 10 warm-ups, then 100 timed samples. */
async function measure(fn: () => Promise<unknown>, warmups = WARMUPS, samples = SAMPLES): Promise<Stats> {
  for (let i = 0; i < warmups; i += 1) await fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)] as number;
  return { p50: at(0.5), p95: at(0.95), max: times[times.length - 1] as number };
}
const fmt = (s: Stats) => `p50 ${s.p50.toFixed(1)} / p95 ${s.p95.toFixed(1)} / max ${s.max.toFixed(1)} ms (node-only, ${WARMUPS} warm-ups, ${SAMPLES} samples)`;

describe.skipIf(process.env.FLASHYDEX_SKIP_PERF === '1')('C16/R12 performance (40k-card catalog, 10k copies; Node only)', () => {
  const searches: Array<[string, Parameters<Harness['catalog']['searchCards']>[0]]> = [
    ['"char" (prefix, as /add runs it)', { q: 'char', match: 'prefix', limit: 30 }],
    ['"pikachu" (prefix)', { q: 'pikachu', match: 'prefix', limit: 30 }],
    ['"char" (contains fallback)', { q: 'char', match: 'contains', limit: 30 }],
    ['"19" (collector number)', { localId: '19', limit: 30 }],
    ['"charizard 20" (name + number)', { q: 'charizard', localId: '20', match: 'prefix', limit: 30 }]
  ];

  for (const [label, query] of searches) {
    it(`search ${label}: p95 < ${BUDGET_MS} ms`, async () => {
      const first = await h.catalog.searchCards(query);
      expect(first.data.length).toBeGreaterThan(0);
      const stats = await measure(() => h.catalog.searchCards(query));
      console.info(`[perf] search ${label}: ${fmt(stats)} (${first.page.total} matches)`);
      expect(stats.p95).toBeLessThan(BUDGET_MS);
    }, 120_000);
  }

  it(`collection grid over 10,000 copies (40 giant groups of 100 + 1,200 small groups of 5): p95 < ${BUDGET_MS} ms; whole-group id lookup is ONE query per page`, async () => {
    for (let n = 0; n < 40; n += 1) {
      await h.collection.bulkAdd({ quantity: 100, copy: copyOf(`perf000-${String(n + 1).padStart(3, '0')}`, { variant: n % 2 ? 'holo' : 'normal' }) });
    }
    for (let n = 0; n < 1200; n += 1) {
      const set = 1 + Math.floor(n / 200);
      await h.collection.bulkAdd({ quantity: 5, copy: copyOf(`perf${String(set).padStart(3, '0')}-${String((n % 200) + 1).padStart(3, '0')}`) });
    }
    expect(Number(await h.t.user.scalar('SELECT COUNT(*) FROM owned_cards'))).toBe(10_000);
    const page = await h.collection.list({ groupBy: 'card', limit: 50 });
    expect(page.page.total).toBe(1240);
    for (const g of page.data as Array<{ totalQty: number; allCopyIds: string[] }>) expect(g.allCopyIds).toHaveLength(g.totalQty);
    // R12: statements executed by one page, counting owned_cards whole-group lookups
    const user = h.t.user as unknown as { rows: (sql: string, params?: readonly unknown[]) => Promise<unknown[][]> };
    const original = user.rows.bind(user);
    let groupLookups = 0;
    user.rows = (sql, params) => {
      if (/SELECT id, language, catalog_card_id, custom_card_id, variant FROM owned_cards WHERE/.test(sql)) groupLookups += 1;
      return original(sql, params);
    };
    await h.collection.list({ groupBy: 'card', limit: 50 });
    user.rows = original;
    expect(groupLookups).toBe(1);

    for (const sort of ['created_desc', 'name_asc', 'count_desc'] as const) {
      const stats = await measure(() => h.collection.list({ groupBy: 'card', limit: 50, sort }));
      console.info(`[perf] collection grid (10k copies) sort=${sort}: ${fmt(stats)}`);
      expect(stats.p95).toBeLessThan(BUDGET_MS);
    }
    const filtered = await measure(() => h.collection.list({ groupBy: 'card', limit: 50, q: 'char' }));
    console.info(`[perf] collection grid (10k copies) q=char: ${fmt(filtered)}`);
    expect(filtered.p95).toBeLessThan(BUDGET_MS);
  }, 300_000);
});
