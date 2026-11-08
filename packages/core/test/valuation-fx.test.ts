import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FxRecord } from '../src/domain/fx';
import { copyOf, harness, installCatalog, TEST_SET, testCards, type Harness } from './helpers';

const RATE: FxRecord = { base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-10-30T11:00:00.000Z' };

let h: Harness;
const setFx = (record: FxRecord | null) => { h.ctx.fx = { get: () => record }; };
const usd = (c: { valuations: Array<{ currency: string }> }) => c.valuations.find((v) => v.currency === 'USD') as Record<string, unknown> | undefined;
const eur = (c: { valuations: Array<{ currency: string }> }) => c.valuations.find((v) => v.currency === 'EUR') as Record<string, unknown> | undefined;

beforeEach(async () => {
  h = await harness();
  await installCatalog(h, 'en', {
    sets: [TEST_SET],
    cards: testCards(),
    prices: [
      { cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 2140, trend: 9999, low: 1 }, // EUR-only
      { cardId: 'tset-001', source: 'cardmarket', variant: 'holo', mid: 3000 },
      { cardId: 'tset-001', source: 'cardmarket', variant: 'reverse_holo', mid: 5000 },
      { cardId: 'tset-001', source: 'cardmarket', variant: 'first_edition', variantDetail: 'holo', mid: 9000 },
      { cardId: 'tset-002', source: 'tcgplayer', variant: 'normal', market: 500, mid: 450 }, // USD + EUR
      { cardId: 'tset-002', source: 'cardmarket', variant: 'normal', mid: 400 },
      { cardId: 'tset-003', source: 'tcgplayer', variant: 'normal', mid: 250 }, // USD-only
      { cardId: 'tset-005', source: 'cardmarket', variant: 'normal', trend: 400 } // no usable EUR mid
    ]
  });
  await installCatalog(h, 'ja', {
    sets: [TEST_SET],
    cards: testCards(),
    prices: [{ cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 100 }]
  });
});
afterEach(() => h.cleanup());

describe('valuation with FX (gate 1-6, 8-11)', () => {
  it('(1) an EUR-only card converts to USD with exact cents and says so', async () => {
    setFx(RATE);
    const copy = await h.collection.add(copyOf('tset-001'));
    const v = usd(copy);
    expect(v).toMatchObject({
      currency: 'USD', cents: 2389, source: 'cardmarket', converted: true, originalCents: 2140, originalCurrency: 'EUR', fxRate: '1.1165',
      fxRateDate: '2026-11-06', fxProvider: 'frankfurter', quoteType: 'avg', stale: false
    });
    expect(eur(copy)).toMatchObject({ cents: 2140, source: 'cardmarket' });
    expect(eur(copy)?.converted).toBeUndefined();
  });

  it('(2) a card with both uses the USD native price, never the converted one', async () => {
    setFx(RATE);
    const copy = await h.collection.add(copyOf('tset-002'));
    expect(usd(copy)).toMatchObject({ cents: 500, source: 'tcgplayer' });
    expect(usd(copy)?.converted).toBeUndefined();
    expect(eur(copy)).toMatchObject({ cents: 400, source: 'cardmarket' });
  });

  it('(3) a USD-only card is unchanged with or without FX', async () => {
    for (const record of [null, RATE]) {
      setFx(record);
      const copy = await h.collection.add(copyOf('tset-003'));
      expect(usd(copy)).toMatchObject({ cents: 250, source: 'tcgplayer' });
      expect(copy.valuations).toHaveLength(1);
    }
  });

  it('(4) catalog_latest_prices rows are untouched; the EUR quote stays EUR and no converted observation is stored', async () => {
    const catalog = await h.t.databases.catalog('en');
    const read = () => catalog!.rows('SELECT source, currency, variant, variant_detail, mid_cents, market_cents FROM catalog_latest_prices ORDER BY source, variant, variant_detail');
    const before = await read();
    setFx(RATE);
    const copy = await h.collection.add(copyOf('tset-001'));
    await h.portfolio.dashboard({});
    expect(await read()).toEqual(before);
    expect(before.some((r) => r[0] === 'cardmarket' && r[1] === 'EUR' && r[4] === 2140)).toBe(true);
    expect(before.some((r) => r[0] === 'cardmarket' && r[1] === 'USD')).toBe(false);
    const history = await h.t.user.rows('SELECT source, currency, mid_cents FROM price_snapshots');
    expect(history.every((r) => (r[0] === 'cardmarket' ? r[1] === 'EUR' : r[1] === 'USD'))).toBe(true);
    expect(history.some((r) => Number(r[2]) === 2389)).toBe(false);
    expect(eur(copy)?.cents).toBe(2140);
  });

  it('(5) with no FX record the USD value is null and nothing is guessed', async () => {
    setFx(null);
    const copy = await h.collection.add(copyOf('tset-001'));
    expect(usd(copy)).toBeUndefined();
    expect(eur(copy)).toMatchObject({ cents: 2140 });
    const read = await h.collection.getCopy({ id: copy.id });
    expect(usd(read)).toBeUndefined();
  });

  it('(5b) an absent provider behaves like no record; a malformed record is ignored', async () => {
    const copy = await h.collection.add(copyOf('tset-001'));
    expect(usd(copy)).toBeUndefined();
    setFx({ ...RATE, rate: '0' });
    expect(usd(await h.collection.getCopy({ id: copy.id }))).toBeUndefined();
  });

  it('(6) the cached record date is surfaced; stale flag only beyond 7 days (clock = 2026-10-30)', async () => {
    const copy = await h.collection.add(copyOf('tset-001'));
    setFx({ ...RATE, rateDate: '2026-10-28' });
    expect(usd(await h.collection.getCopy({ id: copy.id }))).toMatchObject({ fxRateDate: '2026-10-28', stale: false });
    setFx({ ...RATE, rateDate: '2026-10-20' });
    const stale = usd(await h.collection.getCopy({ id: copy.id }));
    expect(stale).toMatchObject({ fxRateDate: '2026-10-20', stale: true, cents: 2389 });
  });

  it('(8) holo and reverse_holo never share a price', async () => {
    setFx(RATE);
    const holo = await h.collection.add(copyOf('tset-001', { variant: 'holo' }));
    const rev = await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' }));
    expect(usd(holo)?.cents).toBe(3350); // 3000 x 1.1165 = 3349.5 -> 3350
    expect(usd(rev)?.cents).toBe(5583); // 5000 x 1.1165 = 5582.5 -> 5583
    const shadow = await h.collection.add(copyOf('tset-001', { variant: 'shadowless' }));
    expect(shadow.valuations).toEqual([]);
  });

  it('(9) first_edition (detail holo) never shares with normal; an unqualified first_edition has no price', async () => {
    setFx(RATE);
    const first = await h.collection.add(copyOf('tset-001', { variant: 'first_edition', variantDetail: 'holo' }));
    const normal = await h.collection.add(copyOf('tset-001'));
    expect(usd(first)?.cents).toBe(10049); // 9000 x 1.1165 = 10048.5 -> 10049
    expect(usd(normal)?.cents).toBe(2389);
    const other = await h.collection.add(copyOf('tset-001', { variant: 'first_edition', variantDetail: 'shadowless' }));
    expect(other.valuations).toEqual([]);
  });

  it('(10) EN and JA copies of the same card id are valued from their own catalog', async () => {
    setFx(RATE);
    const en = await h.collection.add(copyOf('tset-001'));
    const ja = await h.collection.add(copyOf('tset-001', { language: 'ja' }));
    expect(usd(en)?.cents).toBe(2389);
    expect(usd(ja)).toMatchObject({ cents: 112, originalCents: 100 });
    expect(en.id).not.toBe(ja.id);
  });

  it('(11) a graded copy has no automatic value even when converted data exists; the raw copy does', async () => {
    setFx(RATE);
    const raw = await h.collection.add(copyOf('tset-001'));
    const graded = await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never }));
    expect(usd(raw)?.cents).toBe(2389);
    expect(graded.valuations).toEqual([]);
  });

  it('a manual price still wins and is never converted', async () => {
    setFx(RATE);
    const copy = await h.collection.add(copyOf('tset-001', { manualPrice: { cents: 777, currency: 'EUR' } }));
    expect(copy.valuations).toEqual([expect.objectContaining({ currency: 'EUR', cents: 777, source: 'manual' })]);
    const usdManual = await h.collection.add(copyOf('tset-001', { manualPrice: { cents: 900, currency: 'USD' } }));
    expect(usd(usdManual)).toMatchObject({ cents: 900, source: 'manual' });
    expect(usd(usdManual)?.converted).toBeUndefined();
  });

  it('the collection list priced filter and value sort honour converted values', async () => {
    const a = await h.collection.add(copyOf('tset-001'));
    await h.collection.add(copyOf('tset-003'));
    setFx(null);
    expect((await h.collection.list({ groupBy: 'copy', priced: 'some', currency: 'USD' } as never)).page.total).toBe(1);
    setFx(RATE);
    const list = await h.collection.list({ groupBy: 'copy', priced: 'some', currency: 'USD' } as never);
    expect(list.page.total).toBe(2);
    expect(JSON.stringify(list)).toContain(a.id);
  });
});
