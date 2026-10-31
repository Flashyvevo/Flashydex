import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import { copyOf, customCopy, harness, installCatalog, installStandardCatalog, TEST_SET, testCards, type Harness } from './helpers';
import type { CollectionCardGroup } from '../src/services/collection-list';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

/** Shared fixture for acceptance 9/14: 3 EN normal same identity (NM/LP/graded) + 1 EN reverse + 1 JA same provider id + 1 custom. */
async function acceptanceNineFixture() {
  await installStandardCatalog(h, 'en');
  await installCatalog(h, 'ja', { sets: [TEST_SET], cards: testCards().map((c) => ({ ...c, name: `JA ${c.name}` })) });
  const nm = await h.collection.add(copyOf('tset-001', { condition: 'NM' }));
  const lp = await h.collection.add(copyOf('tset-001', { condition: 'LP' }));
  const graded = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never }));
  const reverse = await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' }));
  const ja = await h.collection.add({ ...copyOf('tset-001'), language: 'ja' });
  const custom = await h.collection.createCustom({ name: 'Home Brew', language: 'en' });
  const customOwned = await h.collection.add(customCopy(custom.id));
  return { nm, lp, graded, reverse, ja, custom, customOwned };
}

describe('grouped collection view (9, 14)', () => {
  it('total 6, unique 4, duplicates 2: grade/condition do not split, language/variant/custom do', async () => {
    await acceptanceNineFixture();
    const dash = await h.portfolio.dashboard({});
    expect(dash).toMatchObject({ totalCards: 6, totalCopies: 6, uniqueCards: 4, duplicates: 2 });
    const groups = (await h.collection.list({})).data;
    expect(groups).toHaveLength(4); // one tile per (language, cardId, variant): never one per copy
  });

  it('returns qty / matching copyIds / whole-group totals / representative / summaries', async () => {
    const f = await acceptanceNineFixture();
    const page = await h.collection.list({ groupBy: 'card', condition: 'NM' });
    expect(page.page.total).toBe(1);
    const g = page.data[0] as CollectionCardGroup;
    expect(g).toMatchObject({ source: 'catalog', language: 'en', cardId: 'tset-001', variant: 'normal', qty: 1, totalQty: 3 });
    expect(g.copyIds).toEqual([f.nm.id]);
    expect(g.allCopyIds).toEqual([f.nm.id, f.lp.id, f.graded.id].sort());
    expect(g.representative.id).toBe(f.nm.id);
    expect(g.representative.duplicateCount).toBe(3); // precise group size, regardless of the filter

    const all = (await h.collection.list({})).data as CollectionCardGroup[];
    const normal = all.find((x) => x.cardId === 'tset-001' && x.language === 'en' && x.variant === 'normal') as CollectionCardGroup;
    expect(normal).toMatchObject({ qty: 3, totalQty: 3, grading: { raw: 2, graded: 1 } });
    expect(normal.conditions).toEqual([{ condition: 'NM', qty: 1 }, { condition: 'LP', qty: 1 }, { condition: null, qty: 1 }]);
    expect(normal.representative.id).toBe(f.graded.id); // newest matching copy
    expect(all.find((x) => x.source === 'custom')).toMatchObject({ cardId: f.custom.id, qty: 1 });
    expect(all.filter((x) => x.cardId === 'tset-001' && x.language === 'ja')).toHaveLength(1); // same provider id, separate language
  });

  it('variantDetail subgroups stay inside ONE tile', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo', variantDetail: 'pokeball' }));
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo', variantDetail: 'masterball' }));
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' }));
    const page = await h.collection.list({});
    expect(page.page.total).toBe(1);
    const g = page.data[0] as CollectionCardGroup;
    expect(g.qty).toBe(3);
    expect(g.variantDetails).toEqual([{ variantDetail: '', qty: 1 }, { variantDetail: 'masterball', qty: 1 }, { variantDetail: 'pokeball', qty: 1 }]);
    // Dashboard keeps the PRECISE equation: three different prints are 3 unique cards, 0 extras.
    expect(await h.portfolio.dashboard({})).toMatchObject({ uniqueCards: 3, duplicates: 0 });
  });

  it('pages 125 matching rows as 30/30/30/30/5 in both modes with exact totals and no gaps or repeats', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.bulkAdd({ quantity: 100, copy: copyOf('tset-001') });
    await h.collection.bulkAdd({ quantity: 25, copy: copyOf('tset-002') });
    const seen = new Set<string>();
    const sizes: number[] = [];
    for (let offset = 0; offset < 125; offset += 30) {
      const page = await h.collection.list({ groupBy: 'copy', offset });
      sizes.push(page.data.length);
      expect(page.page).toMatchObject({ total: 125, offset, limit: 30, hasMore: offset + page.data.length < 125 });
      page.data.forEach((c) => { expect(seen.has(c.id)).toBe(false); seen.add(c.id); });
    }
    expect(sizes).toEqual([30, 30, 30, 30, 5]);
    expect(seen.size).toBe(125);

    for (let i = 0; i < 125; i += 1) {
      const c = await h.collection.createCustom({ name: `Custom ${String(i).padStart(3, '0')}`, language: 'en' });
      await h.collection.add(customCopy(c.id));
    }
    const groupSizes: number[] = [];
    const keys = new Set<string>();
    for (let offset = 0; offset < 200; offset += 30) {
      const page = (await h.collection.list({ groupBy: 'card', offset, hideTcgPocket: false })).data as CollectionCardGroup[];
      if (page.length === 0) break;
      groupSizes.push(page.length);
      page.forEach((g) => keys.add(`${g.source}|${g.cardId}|${g.variant}`));
    }
    expect(groupSizes).toEqual([30, 30, 30, 30, 7]); // 125 customs + 2 catalog groups = 127
    expect(keys.size).toBe(127);
  });

  it('a huge group carries complete id arrays but only one full OwnedDto', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.bulkAdd({ quantity: 100, copy: copyOf('tset-001') });
    await h.collection.bulkAdd({ quantity: 60, copy: copyOf('tset-001') });
    const page = await h.collection.list({});
    const g = page.data[0] as CollectionCardGroup;
    expect(page.page.total).toBe(1);
    expect(g.qty).toBe(160);
    expect(g.copyIds).toHaveLength(160);
    expect(g.allCopyIds).toHaveLength(160);
    expect(new Set(g.copyIds).size).toBe(160);
    expect([...g.copyIds]).toEqual([...g.copyIds].sort());
    expect(typeof g.representative).toBe('object');
  });

  it('rejects count_desc in copy mode and unknown query keys', async () => {
    await expect(h.collection.list({ groupBy: 'copy', sort: 'count_desc' })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.collection.list({ limit: 51 })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.collection.list({ offset: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.collection.list({ limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.collection.list({ bogus: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('filters (15, 16)', () => {
  it('every filter alone and intersected', async () => {
    await installStandardCatalog(h, 'en');
    await installCatalog(h, 'ja', { sets: [TEST_SET], cards: testCards().map((c) => ({ ...c, name: `JA ${c.name}` })) });
    const box = await h.collection.createLocation({ name: 'Box' });
    const grp = await h.collection.createGroup({ name: 'Deck' });
    const acq = await h.collection.createAcquisition({ purchasedOn: '2026-01-01', source: 'Shop' });
    const a = await h.collection.add(copyOf('tset-001', { condition: 'NM', storageLocationId: box.id, groupIds: [grp.id], acquisition: { id: acq.id } }));
    const b = await h.collection.add(copyOf('tset-001', { condition: 'LP' }));
    const c = await h.collection.add(copyOf('tset-002', { grade: { company: 'PSA', grade: '10' } as never }));
    const d = await h.collection.add(copyOf('tset-001', { variant: 'holo' }));
    const e = await h.collection.add({ ...copyOf('tset-003'), language: 'ja' });
    const ids = async (q: Record<string, unknown>) => ((await h.collection.list({ groupBy: 'copy', ...q } as never)).data as Array<{ id: string }>).map((x) => x.id).sort();
    const sorted = (...xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();

    expect(await ids({ q: 'alpha' })).toEqual(sorted(a, b, d));
    expect(await ids({ q: 'JA' })).toEqual(sorted(e)); // normalized contains
    expect(await ids({ q: 'a_' })).toEqual([]); // underscore is literal, not a wildcard
    expect(await ids({ q: '%' })).toEqual([]);
    expect(await ids({ setId: 'tset' })).toEqual(sorted(a, b, c, d, e));
    expect(await ids({ rarity: 'Rare' })).toEqual(sorted(a, b, d));
    expect(await ids({ language: 'ja' })).toEqual(sorted(e));
    expect(await ids({ condition: 'NM' })).toEqual(sorted(a));
    expect(await ids({ condition: 'unknown' })).toEqual(sorted(c, d, e));
    expect(await ids({ grading: 'graded' })).toEqual(sorted(c));
    expect(await ids({ grading: 'raw' })).toEqual(sorted(a, b, d, e));
    expect(await ids({ duplicates: true })).toEqual(sorted(a, b));
    expect(await ids({ duplicates: false })).toEqual(sorted(c, d, e));
    expect(await ids({ storageLocationId: box.id })).toEqual(sorted(a));
    expect(await ids({ storageLocationId: 'none' })).toEqual(sorted(b, c, d, e));
    expect(await ids({ groupId: grp.id })).toEqual(sorted(a));
    expect(await ids({ variant: 'holo' })).toEqual(sorted(d));
    expect(await ids({ acquisitionId: acq.id })).toEqual(sorted(a));
    expect(await ids({ localId: '001' })).toEqual(sorted(a, b, d));
    expect(await ids({ localId: '1' })).toEqual([]); // '001' !== '1'
    expect(await ids({ language: 'en', variant: 'normal', condition: 'unknown' })).toEqual(sorted(c));
    expect(await ids({ q: 'alpha', duplicates: true, condition: 'LP' })).toEqual(sorted(b));
  });

  it('duplicates are computed across the WHOLE collection before other filters; deleting one of a pair resets duplicateCount (16)', async () => {
    await installStandardCatalog(h, 'en');
    const box = await h.collection.createLocation({ name: 'Box' });
    const a = await h.collection.add(copyOf('tset-001', { condition: 'NM', storageLocationId: box.id }));
    const b = await h.collection.add(copyOf('tset-001', { condition: 'LP' }));
    const visible = await h.collection.list({ groupBy: 'copy', duplicates: true, storageLocationId: box.id });
    expect(visible.data.map((c) => c.id)).toEqual([a.id]); // only one of the pair is visible but it is still a duplicate
    expect(visible.data[0]?.duplicateCount).toBe(2);
    expect(await h.portfolio.dashboard({})).toMatchObject({ duplicates: 1 });
    await h.collection.remove({ id: b.id });
    expect((await h.collection.getCopy({ id: a.id })).duplicateCount).toBe(1);
    expect(await h.portfolio.dashboard({})).toMatchObject({ duplicates: 0 });
    expect((await h.collection.list({ groupBy: 'copy', duplicates: true })).page.total).toBe(0);
  });

  it('hideTcgPocket excludes known series tcgp by default; unknown-series snapshots stay visible; totals unaffected', async () => {
    await installStandardCatalog(h, 'en');
    await h.collection.add(copyOf('tset-001'));
    await h.collection.add(copyOf('pocket-001'));
    const custom = await h.collection.createCustom({ name: 'Mine', language: 'en', setId: 'pocket' });
    await h.collection.add(customCopy(custom.id)); // custom never hidden even if setId looks like pocket
    expect((await h.collection.list({ groupBy: 'copy' })).page.total).toBe(2); // default hides tcgp
    expect((await h.collection.list({ groupBy: 'copy', hideTcgPocket: false })).page.total).toBe(3);
    await h.collection.add({ ...copyOf('tset-001'), language: 'en' });
    // Offline snapshot with no catalog (series unknown) stays visible.
    await h.t.databases.close();
    const reopened = await h.t.reopen();
    const { rmSync } = await import('node:fs');
    rmSync(reopened.catalogPath('en'));
    const h2 = (await import('./helpers')).harnessFor(await reopened.reopen());
    expect((await h2.collection.list({ groupBy: 'copy' })).page.total).toBe(4);
    expect(await h2.portfolio.dashboard({})).toMatchObject({ totalCards: 4 });
    await h2.cleanup();
  });
});

describe('priced filter and value sorts (15)', () => {
  beforeEach(async () => {
    await installCatalog(h, 'en', {
      sets: [TEST_SET],
      cards: testCards(),
      prices: [
        { cardId: 'tset-001', source: 'tcgplayer', variant: 'normal', market: 500, mid: 400, low: 100 },
        { cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 450, trend: 460 },
        { cardId: 'tset-002', source: 'tcgplayer', variant: 'normal', mid: 300 },
        { cardId: 'tset-003', source: 'tcgplayer', variant: 'normal', low: 50 },
        { cardId: 'tset-005', source: 'tcgplayer', variant: 'normal', market: 0 },
        { cardId: 'tset-004', source: 'cardmarket', variant: 'normal', mid: 800 }
      ]
    });
    await h.collection.bulkAdd({ quantity: 2, copy: copyOf('tset-001') });
    for (const id of ['tset-002', 'tset-003', 'tset-004', 'tset-005']) await h.collection.add(copyOf(id));
  });

  const names = async (q: Record<string, unknown>) => ((await h.collection.list(q as never)).data as unknown as CollectionCardGroup[]).map((g) => g.representative.name);

  it('priced none/some per currency; zero is priced; EUR-only is no-USD; low-only is unpriced', async () => {
    expect((await names({ priced: 'some', currency: 'USD' })).sort()).toEqual(['Alpha Beast', 'Alpha Mon', 'Beta Mon']);
    expect((await names({ priced: 'none', currency: 'USD' })).sort()).toEqual(['Delta Mon', 'Gamma Mon']); // Delta has only EUR; Gamma only low
    expect((await names({ priced: 'some', currency: 'EUR' })).sort()).toEqual(['Alpha Mon', 'Delta Mon']);
  });

  it('value sorts sum known matching-copy values, null-last in BOTH directions, deterministic ties', async () => {
    expect(await names({ sort: 'value_desc', currency: 'USD' })).toEqual(['Alpha Mon', 'Beta Mon', 'Alpha Beast', 'Gamma Mon', 'Delta Mon']); // 1000, 300, 0 (known zero), then nulls by identity
    expect(await names({ sort: 'value_asc', currency: 'USD' })).toEqual(['Alpha Beast', 'Beta Mon', 'Alpha Mon', 'Gamma Mon', 'Delta Mon']); // 0, 300, 1000, then nulls last
    expect((await names({ sort: 'value_desc', currency: 'EUR' })).slice(0, 2)).toEqual(['Alpha Mon', 'Delta Mon']); // 900 then 800
  });

  it('count_desc, name_asc, set_asc, created_desc order groups deterministically', async () => {
    expect((await names({ sort: 'count_desc' }))[0]).toBe('Alpha Mon');
    expect(await names({ sort: 'name_asc' })).toEqual(['Alpha Beast', 'Alpha Mon', 'Beta Mon', 'Delta Mon', 'Gamma Mon']);
    expect(await names({ sort: 'set_asc' })).toEqual(['Alpha Mon', 'Beta Mon', 'Gamma Mon', 'Delta Mon', 'Alpha Beast']);
    expect((await names({ sort: 'created_desc' }))[0]).toBe('Alpha Beast');
  });

  it('a graded copy without an override is unpriced; a manual override wins in its own currency', async () => {
    const graded = await h.collection.add(copyOf('tset-002', { grade: { company: 'PSA', grade: '10' } as never }));
    expect(graded.valuations).toEqual([]);
    const manual = await h.collection.update({ id: graded.id, patch: { manualPrice: { cents: 12345, currency: 'EUR' } } });
    expect(manual.valuations).toMatchObject([{ currency: 'EUR', cents: 12345, source: 'manual' }]);
    const usd = (await h.collection.list({ groupBy: 'copy', priced: 'some', currency: 'USD' })).data;
    expect(usd.map((c) => c.id)).not.toContain(graded.id); // manual EUR replaces automatic USD for that copy
  });
});
