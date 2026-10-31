import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureCard, FixtureSet } from '../src/testing/catalog-fixture';
import { copyOf, harness, installCatalog, type Harness } from './helpers';

/** C16: search over a 40,000-row synthetic catalog and the collection grid over 5,000 owned rows each answer in < 300 ms (warm). */
const BUDGET_MS = 300;
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

async function timeOf(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe('C16 performance budget (40k-card catalog)', () => {
  const searches: Array<[string, Parameters<Harness['catalog']['searchCards']>[0]]> = [
    ['"char" (prefix, as /add runs it)', { q: 'char', match: 'prefix', limit: 30 }],
    ['"pikachu" (prefix)', { q: 'pikachu', match: 'prefix', limit: 30 }],
    ['"char" (contains fallback)', { q: 'char', match: 'contains', limit: 30 }],
    ['"19" (collector number)', { localId: '19', limit: 30 }],
    ['"charizard 20" (name + number)', { q: 'charizard', localId: '20', match: 'prefix', limit: 30 }]
  ];

  for (const [label, query] of searches) {
    it(`search ${label} < ${BUDGET_MS} ms`, async () => {
      const first = await h.catalog.searchCards(query); // warm-up (also proves the query returns rows)
      expect(first.data.length).toBeGreaterThan(0);
      const ms = await timeOf(() => h.catalog.searchCards(query));
      console.info(`[perf] search ${label}: ${ms.toFixed(1)} ms (${first.page.total} matches)`);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it(`collection grid over 5,000 owned rows < ${BUDGET_MS} ms`, async () => {
    for (let n = 0; n < 50; n += 1) {
      await h.collection.bulkAdd({ quantity: 100, copy: copyOf(`perf000-${String(n + 1).padStart(3, '0')}`, { variant: n % 2 ? 'holo' : 'normal' }) });
    }
    await h.collection.list({ groupBy: 'card', limit: 30 }); // warm-up
    for (const sort of ['created_desc', 'name_asc', 'count_desc'] as const) {
      const ms = await timeOf(() => h.collection.list({ groupBy: 'card', limit: 30, sort }));
      console.info(`[perf] collection grid sort=${sort}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
    const filtered = await timeOf(() => h.collection.list({ groupBy: 'card', limit: 30, q: 'char' }));
    console.info(`[perf] collection grid q=char: ${filtered.toFixed(1)} ms`);
    expect(filtered).toBeLessThan(BUDGET_MS);
  }, 120_000);
});
