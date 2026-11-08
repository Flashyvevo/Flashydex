import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FxRecord } from '../src/domain/fx';
import { copyOf, harness, installCatalog, TEST_SET, testCards, type Harness } from './helpers';

const RATE: FxRecord = { base: 'EUR', quote: 'USD', rate: '1.1165', rateDate: '2026-11-06', provider: 'frankfurter', fetchedAt: '2026-10-30T11:00:00.000Z' };

let h: Harness;
const setFx = (record: FxRecord | null) => { h.ctx.fx = { get: () => record }; };
const usdStats = async () => (await h.portfolio.dashboard({})).currencies[0]!;

beforeEach(async () => {
  h = await harness();
  await installCatalog(h, 'en', {
    sets: [TEST_SET],
    cards: testCards(),
    prices: [
      { cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 2140 }, // EUR-only -> 2389
      { cardId: 'tset-002', source: 'tcgplayer', variant: 'normal', market: 500 },
      { cardId: 'tset-002', source: 'cardmarket', variant: 'normal', mid: 400 }, // both: counted once, USD native
      { cardId: 'tset-003', source: 'tcgplayer', variant: 'normal', mid: 250 },
      { cardId: 'tset-005', source: 'cardmarket', variant: 'normal', trend: 400 }
    ]
  });
});
afterEach(() => h.cleanup());

describe('portfolio with FX', () => {
  it('(7) three copies aggregate to 3x the value and each copy is counted once', async () => {
    setFx(RATE);
    for (let i = 0; i < 3; i += 1) await h.collection.add(copyOf('tset-001'));
    const d = await h.portfolio.dashboard({});
    expect(d.currencies[0]).toMatchObject({
      estimatedValueCents: 3 * 2389, valuedCopies: 3, convertedCopies: 3, convertedValueCents: 3 * 2389, sourcePricedCopies: 0, staleFxCopies: 0,
      fxUnavailableCopies: 0, fxRateDate: '2026-11-06', unvaluedCopies: 0
    });
    expect(d.pricedCopies).toBe(3);
    expect(d.currencies[1]).toMatchObject({ estimatedValueCents: 3 * 2140, valuedCopies: 3 }); // EUR bucket unchanged and separate
  });

  it('tcgplayer + cardmarket for one copy is never double counted; mixed totals add only USD amounts', async () => {
    setFx(RATE);
    await h.collection.add(copyOf('tset-001')); // converted 2389
    await h.collection.add(copyOf('tset-002')); // native 500 (cardmarket 400 ignored for USD)
    await h.collection.add(copyOf('tset-003')); // native 250
    const s = await usdStats();
    expect(s).toMatchObject({ estimatedValueCents: 2389 + 500 + 250, valuedCopies: 3, sourcePricedCopies: 2, convertedCopies: 1, convertedValueCents: 2389 });
  });

  it('(5) no FX record: EUR-only copies are unpriced in USD and counted as fx_unavailable; totals unchanged', async () => {
    setFx(null);
    await h.collection.add(copyOf('tset-001'));
    await h.collection.add(copyOf('tset-001'));
    await h.collection.add(copyOf('tset-003'));
    const s = await usdStats();
    expect(s).toMatchObject({
      estimatedValueCents: 250, valuedCopies: 1, unvaluedCopies: 2, convertedCopies: 0, convertedValueCents: 0, fxUnavailableCopies: 2, sourcePricedCopies: 1, fxRateDate: null
    });
  });

  it('(6) stale FX is counted and still used', async () => {
    setFx({ ...RATE, rateDate: '2026-10-10' });
    await h.collection.add(copyOf('tset-001'));
    expect(await usdStats()).toMatchObject({ convertedCopies: 1, staleFxCopies: 1, estimatedValueCents: 2389, fxRateDate: '2026-10-10' });
  });

  it('(11) graded copies are not valued automatically and never count as fx_unavailable', async () => {
    setFx(null);
    await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '10' } as never }));
    await h.collection.add(copyOf('tset-001'));
    const s = await usdStats();
    expect(s).toMatchObject({ valuedCopies: 0, unvaluedCopies: 2, fxUnavailableCopies: 1 }); // only the raw copy
    setFx(RATE);
    expect(await usdStats()).toMatchObject({ valuedCopies: 1, unvaluedCopies: 1, estimatedValueCents: 2389, convertedCopies: 1 });
  });

  it('(12) a missing price is not zero: the copy is excluded from the bucket and totals are unchanged', async () => {
    setFx(RATE);
    await h.collection.add(copyOf('tset-003'));
    const before = await usdStats();
    await h.collection.add(copyOf('tset-004')); // no price rows at all
    await h.collection.add(copyOf('tset-005')); // trend only: no usable mid
    const after = await usdStats();
    expect(after.estimatedValueCents).toBe(before.estimatedValueCents);
    expect(after).toMatchObject({ valuedCopies: 1, unvaluedCopies: 2, totalCopies: 3, fxUnavailableCopies: 0 });
    // and with nothing priced at all the value is null, not 0
    const empty = await harness();
    try {
      empty.ctx.fx = { get: () => RATE };
      await installCatalog(empty, 'en', { sets: [TEST_SET], cards: testCards() });
      await empty.collection.add(copyOf('tset-001'));
      expect((await empty.portfolio.dashboard({})).currencies[0]?.estimatedValueCents).toBeNull();
    } finally {
      await empty.cleanup();
    }
  });

  it('gain/loss: an EUR cost is converted with the same FX record and flagged; USD cost needs none', async () => {
    setFx(RATE);
    await h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 2000, currency: 'EUR' } })); // cost 2000 EUR -> 2233 USD; value 2389
    await h.collection.add(copyOf('tset-003', { purchasePrice: { cents: 100, currency: 'USD' } })); // cost 100 USD; value 250
    const s = await usdStats();
    expect(s).toMatchObject({
      comparableCopies: 2, comparableCostCents: 2233 + 100, comparableValueCents: 2389 + 250, gainLossCents: 2639 - 2333, costConvertedCopies: 1,
      totalPaidCents: 100, knownCostCopies: 1 // Total paid stays per currency and never mixes
    });
    expect((await h.portfolio.dashboard({})).currencies[1]).toMatchObject({ totalPaidCents: 2000 });
  });

  it('without FX an EUR cost against a USD value is NOT comparable (no guessing)', async () => {
    setFx(null);
    await h.collection.add(copyOf('tset-003', { purchasePrice: { cents: 100, currency: 'EUR' } }));
    expect(await usdStats()).toMatchObject({ comparableCopies: 0, gainLossCents: null, costConvertedCopies: 0 });
  });

  it('without a provider the dashboard matches pre-FX behaviour (EUR-only card unvalued in USD)', async () => {
    delete h.ctx.fx;
    await h.collection.add(copyOf('tset-001'));
    expect(await usdStats()).toMatchObject({ estimatedValueCents: null, valuedCopies: 0, fxUnavailableCopies: 1 });
  });
});
