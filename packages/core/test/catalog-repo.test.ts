import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '../src/errors';
import { copyOf, customCopy, harness, installCatalog, installStandardCatalog, TEST_SET, testCards, type Harness } from './helpers';
import type { FixtureCard } from '../src/testing/catalog-fixture';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

describe('listSets / getSet / listSetCards (30, 31, 32, 53)', () => {
  it('31: 3 normal + 1 reverse of one identity in a 5-card set => owned 4, unique 1, missing 4, extras 2, completion 20.00; customs separate', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.bulkAdd({ quantity: 3, copy: copyOf('tset-001') });
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' }));
    const custom = await h.collection.createCustom({ name: 'Fan Card', language: 'en', setId: 'tset', setName: 'Test Set Alpha', localId: 'F1' });
    await h.collection.bulkAdd({ quantity: 2, copy: customCopy(custom.id) });
    const set = await h.catalog.getSet({ language: 'en', setId: 'tset' });
    expect(set).toMatchObject({
      id: 'tset', language: 'en', status: 'published', catalogCount: 5, catalogComplete: true, officialCount: 5, totalCount: 5, ownedCount: 4, ownedUnique: 1,
      missingCount: 4, duplicateExtras: 2, completionPercent: 20, customOwnedCount: 2
    });
    expect(set.missingPreview.map((c) => c.id)).toEqual(['tset-002', 'tset-003', 'tset-004', 'tset-005']);
    expect(set.missingPreview[0]).toMatchObject({ ownedCount: 0, detailsComplete: true, availableVariants: ['normal'] });
  });

  it('30: EN and JA sets with the same provider id stay separate', async () => {
    await installStandardCatalog(h, 'en');
    await installCatalog(h, 'ja', { sets: [{ ...TEST_SET, name: 'テストセット' }], cards: testCards().map((c) => ({ ...c, name: `JA ${c.name}` })) });
    await h.collection.add(copyOf('tset-001'));
    const en = await h.catalog.getSet({ language: 'en', setId: 'tset' });
    const ja = await h.catalog.getSet({ language: 'ja', setId: 'tset' });
    expect(en.ownedCount).toBe(1);
    expect(ja.ownedCount).toBe(0);
    expect(ja.name).toBe('テストセット');
    const list = await h.catalog.listSets({ hideTcgPocket: false });
    expect(list.data.filter((s) => s.id === 'tset').map((s) => s.language)).toEqual(['en', 'ja']);
  });

  it('32: missing = active-manifest cards with no owned identity in ANY variant; completion 0 when unowned; extras removed upstream never inflate the denominator', async () => {
    const cards: FixtureCard[] = [...testCards(), { id: 'tset-099', setId: 'tset', localId: '099', name: 'Removed Upstream' }];
    await installCatalog(h, 'en', { sets: [{ ...TEST_SET, manifest: ['tset-001', 'tset-002', 'tset-003', 'tset-004', 'tset-005'] }], cards });
    expect((await h.catalog.getSet({ language: 'en', setId: 'tset' })).completionPercent).toBe(0); // unowned: 0, not null
    await h.collection.add(copyOf('tset-001', { variant: 'holo' })); // any variant removes it from missing
    const missing = await h.catalog.listSetCards({ language: 'en', setId: 'tset', ownership: 'missing' });
    expect(missing.data.map((c) => c.id)).toEqual(['tset-002', 'tset-003', 'tset-004', 'tset-005']);
    expect(missing.page.total).toBe(4);
    const all = await h.catalog.listSetCards({ language: 'en', setId: 'tset' });
    expect(all.page.total).toBe(5); // tset-099 is cached but not in the manifest
    const set = await h.catalog.getSet({ language: 'en', setId: 'tset' });
    expect(set).toMatchObject({ catalogCount: 5, completionPercent: 20, missingCount: 4 });
  });

  it('32: an incomplete catalog has completion null (never a false 100%) and exposes the loaded count', async () => {
    await installCatalog(h, 'en', {
      sets: [{ ...TEST_SET, manifest: ['tset-001', 'tset-002', 'tset-003', 'tset-004', 'tset-005'] }],
      cards: testCards().slice(0, 3) // manifest lists 5, only 3 cached
    });
    await h.collection.add(copyOf('tset-001'));
    const set = await h.catalog.getSet({ language: 'en', setId: 'tset' });
    expect(set).toMatchObject({ catalogCount: 3, catalogComplete: false, completionPercent: null, ownedUnique: 1, totalCount: 5 });
  });

  it('unpublished shells are hidden by default, shown on request, exact lookup works, no false completion', async () => {
    await installStandardCatalog(h, 'en');
    const dflt = await h.catalog.listSets({ hideTcgPocket: false });
    expect(dflt.data.map((s) => s.id)).toEqual(['pocket', 'tset']); // release DESC: pocket 2024, tset 2020
    const all = await h.catalog.listSets({ status: 'all', hideTcgPocket: false });
    expect(all.data.map((s) => s.id)).toEqual(['pocket', 'shell', 'tset']); // release DESC: 2024, 2021, 2020
    const shell = await h.catalog.getSet({ language: 'en', setId: 'shell' });
    expect(shell).toMatchObject({ status: 'unpublished', catalogCount: 0, completionPercent: null, officialCount: 0, totalCount: 30, missingCount: 0 });
    expect(await h.catalog.listSets({ status: 'unpublished' })).toMatchObject({ page: { total: 1 } });
  });

  it('hideTcgPocket defaults to the setting; owned / q filters; every sort with null-last', async () => {
    await installStandardCatalog(h, 'en');
    expect((await h.catalog.listSets({})).data.map((s) => s.id)).toEqual(['tset']); // tcgp hidden by default
    expect((await h.catalog.listSets({ hideTcgPocket: false })).data.map((s) => s.id)).toContain('pocket');
    await h.settings.update({ hideTcgPocket: false });
    expect((await h.catalog.listSets({})).data.map((s) => s.id)).toContain('pocket');
    await h.collection.add(copyOf('pocket-001'));
    expect((await h.catalog.listSets({ owned: true })).data.map((s) => s.id)).toEqual(['pocket']);
    expect((await h.catalog.listSets({ owned: false })).data.map((s) => s.id)).toEqual(['tset']);
    expect((await h.catalog.listSets({ q: 'alpha' })).data.map((s) => s.id)).toEqual(['tset']);
    expect((await h.catalog.listSets({ sort: 'name_asc', status: 'all' })).data.map((s) => s.id)).toEqual(['shell', 'pocket', 'tset']);
    // completion_desc: pocket 100% (1 of 1), tset 0%, shell null last.
    const byCompletion = await h.catalog.listSets({ sort: 'completion_desc', status: 'all' });
    expect(byCompletion.data.map((s) => [s.id, s.completionPercent])).toEqual([['pocket', 100], ['tset', 0], ['shell', null]]);
  });

  it('missingPreview is capped at 20; full missing list is paginated', async () => {
    const cards: FixtureCard[] = Array.from({ length: 45 }, (_, i) => ({ id: `big-${String(i + 1).padStart(3, '0')}`, setId: 'big', localId: String(i + 1).padStart(3, '0'), name: `Big ${i + 1}` }));
    await installCatalog(h, 'en', { sets: [{ id: 'big', name: 'Big Set', series: 's' }], cards });
    const set = await h.catalog.getSet({ language: 'en', setId: 'big' });
    expect(set.missingPreview).toHaveLength(20);
    expect(set.missingPreview[0]?.id).toBe('big-001');
    const page2 = await h.catalog.listSetCards({ language: 'en', setId: 'big', ownership: 'missing', offset: 30, limit: 30 });
    expect(page2.data).toHaveLength(15);
    expect(page2.page).toEqual({ offset: 30, limit: 30, total: 45, hasMore: false });
  });

  it('duplicates tab uses precise variant grouping; owned tab lists owned cards', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.add(copyOf('tset-001'));
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' })); // different print: not a duplicate
    await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-002') });
    expect((await h.catalog.listSetCards({ language: 'en', setId: 'tset', duplicates: true })).data.map((c) => c.id)).toEqual(['tset-002']);
    expect((await h.catalog.listSetCards({ language: 'en', setId: 'tset', ownership: 'owned' })).data.map((c) => [c.id, c.ownedCount])).toEqual([['tset-001', 2], ['tset-002', 2]]);
  });

  it('NotFoundError for a missing set / absent catalog; invalid paging rejected', async () => {
    await installStandardCatalog(h, 'en');
    await expect(h.catalog.getSet({ language: 'en', setId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.catalog.getSet({ language: 'ja', setId: 'tset' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.catalog.listSetCards({ language: 'en', setId: 'nope' })).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 1.5 }]) {
      await expect(h.catalog.listSets(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await h.catalog.listSets({ language: 'ja' })).data).toEqual([]); // absent catalog: empty page, no error
  });
});

describe('searchCards (19, 53)', () => {
  beforeEach(async () => {
    await installCatalog(h, 'en', {
      sets: [TEST_SET, { id: 'pocket', name: 'Pocket Set', series: 'tcgp' }],
      cards: [
        ...testCards(),
        { id: 'tset-1', setId: 'tset', localId: '1', name: 'One Mon', rarity: 'Rare' },
        { id: 'tset-pc', setId: 'tset', localId: 'P_1', name: '100% Mon_x\\y', rarity: 'Promo' },
        { id: 'tset-cap', setId: 'tset', localId: 'C1', name: 'Mon Alpha' },
        { id: 'pocket-001', setId: 'pocket', localId: '001', name: 'Alpha Pocket' }
      ]
    });
  });
  const ids = async (q: Record<string, unknown>) => ((await h.catalog.searchCards({ hideTcgPocket: false, ...q } as never)).data).map((c) => c.id);

  it('prefix ranks exact over prefix; contains adds contains matches last', async () => {
    expect(await ids({ q: 'alpha' })).toEqual(['tset-005', 'tset-001', 'pocket-001']); // all prefix matches, then name order
    expect(await ids({ q: 'alpha', match: 'contains' })).toEqual(['tset-005', 'tset-001', 'pocket-001', 'tset-cap']); // contains-only ranks last
    expect(await ids({ q: 'alpha mon' })).toEqual(['tset-001']);
    expect(await ids({ q: 'ALPHA MON' })).toEqual(['tset-001']);
    expect((await ids({ q: 'mon', match: 'contains' }))[0]).toBe('tset-cap'); // prefix-rank beats alphabetical: 'mon alpha' starts with mon
  });

  it("exact localId: '001' and '1' are different collector identifiers", async () => {
    expect(await ids({ localId: '001' })).toEqual(['tset-001', 'pocket-001']);
    expect(await ids({ localId: '1' })).toEqual(['tset-1']);
    expect(await ids({ localId: '01' })).toEqual([]);
  });

  it('exact set / language / rarity filters AND together', async () => {
    expect((await ids({ setId: 'tset', rarity: 'Rare' })).sort()).toEqual(['tset-001', 'tset-1']);
    expect(await ids({ setId: 'tset', rarity: 'Rare', localId: '001' })).toEqual(['tset-001']);
    expect(await ids({ language: 'ja' })).toEqual([]);
    expect(await ids({ language: 'en', setId: 'pocket' })).toEqual(['pocket-001']);
  });

  it('%, _ and backslash are literal user characters', async () => {
    expect(await ids({ q: '%' , match: 'contains' })).toEqual(['tset-pc']);
    expect(await ids({ q: '100%' })).toEqual(['tset-pc']);
    expect(await ids({ q: '_', match: 'contains' })).toEqual(['tset-pc']);
    expect(await ids({ q: 'mon_x\\y', match: 'contains' })).toEqual(['tset-pc']);
    expect(await ids({ q: '\\', match: 'contains' })).toEqual(['tset-pc']);
    expect(await ids({ q: 'a%', match: 'contains' })).toEqual([]);
    expect(await ids({ q: '%mon', match: 'contains' })).toEqual([]); // not a wildcard
  });

  it('hideTcgPocket defaults to the setting and can be overridden', async () => {
    expect((await h.catalog.searchCards({ q: 'alpha pocket' })).data).toEqual([]);
    expect((await h.catalog.searchCards({ q: 'alpha pocket', hideTcgPocket: false })).data.map((c) => c.id)).toEqual(['pocket-001']);
  });

  it('Japanese and full-width text is NFKC-normalized, bilingual results merge by rank across languages, totals sum', async () => {
    await installCatalog(h, 'ja', {
      sets: [{ id: 'jset', name: 'ジェイ', series: 'x' }],
      cards: [
        { id: 'jset-001', setId: 'jset', localId: '001', name: 'ＡＬＰＨＡ　モン' },
        { id: 'jset-002', setId: 'jset', localId: '002', name: 'ピカ' },
        { id: 'jset-003', setId: 'jset', localId: '003', name: 'ピカチュウ' }
      ]
    });
    expect(await ids({ q: 'ピカ' })).toEqual(['jset-002', 'jset-003']);
    expect(await ids({ q: 'ﾋﾟｶ' })).toEqual(['jset-002', 'jset-003']); // half-width kana normalizes
    const merged = await h.catalog.searchCards({ q: 'alpha', hideTcgPocket: false, limit: 50 });
    expect(merged.data.map((c) => `${c.language}:${c.id}`)).toEqual(['en:tset-005', 'en:tset-001', 'en:pocket-001', 'ja:jset-001']);
    expect(merged.page.total).toBe(4); // en 3 + ja 1
    const page2 = await h.catalog.searchCards({ q: 'alpha', hideTcgPocket: false, limit: 2, offset: 2 });
    expect(page2.data.map((c) => `${c.language}:${c.id}`)).toEqual(['en:pocket-001', 'ja:jset-001']);
    expect(page2.page).toMatchObject({ total: 4, hasMore: false });
  });

  it('reports owned counts, never fetches or mutates, validates inputs', async () => {
    await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001') });
    await h.collection.add(copyOf('tset-001', { variant: 'holo' }));
    expect((await h.catalog.searchCards({ q: 'alpha mon' })).data[0]).toMatchObject({ id: 'tset-001', ownedCount: 3, setName: 'Test Set Alpha' });
    for (const bad of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { limit: 2.5 }, { q: 'x'.repeat(101) }, { match: 'fuzzy' }, { nope: 1 }]) {
      await expect(h.catalog.searchCards(bad as never)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe('getCard (26, 53)', () => {
  it('more than 50 owned copies are paginated (max 50), newest first; purchase history only for the page; prices latest per key', async () => {
    await installCatalog(h, 'en', {
      sets: [TEST_SET],
      cards: testCards(),
      prices: [
        { cardId: 'tset-001', source: 'tcgplayer', variant: 'normal', market: 700, mid: 600 },
        { cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 500, low: 100, trend: 520 }
      ]
    });
    await h.collection.bulkAdd({ quantity: 60, copy: copyOf('tset-001', { acquisition: { create: { purchasedOn: '2026-02-02', source: 'Bulk Lot' } }, purchasePrice: { cents: 10, currency: 'USD' } }) });
    const first = await h.catalog.getCard({ language: 'en', cardId: 'tset-001', limit: 50 });
    expect(first.ownedCopies.data).toHaveLength(50);
    expect(first.ownedCopies.page).toMatchObject({ total: 60, hasMore: true, limit: 50 });
    expect(first.ownedCount).toBe(60);
    expect(first.purchaseHistory).toHaveLength(50);
    const second = await h.catalog.getCard({ language: 'en', cardId: 'tset-001', limit: 50, offset: 50 });
    expect(second.ownedCopies.data).toHaveLength(10);
    expect(new Set([...first.ownedCopies.data, ...second.ownedCopies.data].map((c) => c.id)).size).toBe(60);
    expect(first.latestPrices.map((p) => [p.source, p.currency, p.marketCents, p.midCents, p.lowCents])).toEqual([['cardmarket', 'EUR', null, 500, 100], ['tcgplayer', 'USD', 700, 600, null]]);
    await expect(h.catalog.getCard({ language: 'en', cardId: 'tset-001', limit: 51 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('a card with no copies has no invented history; missing price stays null; unknown card is NotFoundError', async () => {
    await installStandardCatalog(h, 'en');
    const card = await h.catalog.getCard({ language: 'en', cardId: 'tset-003' });
    expect(card).toMatchObject({ id: 'tset-003', ownedCount: 0, latestPrices: [], purchaseHistory: [], ownedCopies: { data: [], page: { total: 0, hasMore: false } }, detailsComplete: true });
    await expect(h.catalog.getCard({ language: 'en', cardId: 'zzz' })).rejects.toBeInstanceOf(NotFoundError);
  });
});
