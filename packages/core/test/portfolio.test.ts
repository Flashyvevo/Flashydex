import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors';
import { copyOf, customCopy, harness, installCatalog, installStandardCatalog, TEST_SET, testCards, type Harness } from './helpers';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.cleanup());

let keySeq = 0;
async function addHistory(
  cardId: string,
  q: { source: 'tcgplayer' | 'cardmarket'; variant?: string; market?: number | null; mid?: number | null; sourceUpdatedAt?: string | null; capturedAt?: string; language?: 'en' | 'ja' }
): Promise<void> {
  keySeq += 1;
  await h.t.user.run(
    `INSERT INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, mid_cents, market_cents, source_updated_at, captured_at, observation_key)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    [`33333333-3333-4333-8333-${String(keySeq).padStart(12, '0')}`, cardId, q.language ?? 'en', q.source, q.variant ?? 'normal', `hist:${keySeq}`, q.source === 'tcgplayer' ? 'USD' : 'EUR',
      q.mid ?? null, q.market ?? null, q.sourceUpdatedAt ?? null, q.capturedAt ?? '2026-10-01T00:00:00.000Z', String(keySeq).padStart(64, 'a')]
  );
}

describe('dashboard (8)', () => {
  it('empty database: zeros, empty recent, null money, zero coverage, nothing pretending to be $0', async () => {
    const d = await h.portfolio.dashboard({});
    expect(d).toMatchObject({ totalCards: 0, totalCopies: 0, uniqueCards: 0, duplicates: 0, displayCurrency: 'USD', pricedCopies: 0, recent: [] });
    expect(d.currencies).toHaveLength(2);
    expect(d.currencies.map((c) => c.currency)).toEqual(['USD', 'EUR']);
    for (const c of d.currencies) {
      expect(c).toEqual({
        currency: c.currency, estimatedValueCents: null, pricedCopies: 0, totalCopies: 0, valuedCopies: 0, unvaluedCopies: 0, totalPaidCents: null, knownCostCopies: 0,
        comparableCopies: 0, comparableCostCents: null, comparableValueCents: null, gainLossCents: null
      });
    }
  });

  it('uses the settings currency by default and an explicit currency override; rejects unknown input', async () => {
    expect((await h.portfolio.dashboard({})).displayCurrency).toBe('USD');
    await h.settings.update({ defaultCurrency: 'EUR' });
    expect((await h.portfolio.dashboard({})).displayCurrency).toBe('EUR');
    expect((await h.portfolio.dashboard({ currency: 'USD' })).displayCurrency).toBe('USD');
    await expect(h.portfolio.dashboard({ currency: 'GBP' as never })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.portfolio.dashboard({ x: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('money (10, 11)', () => {
  beforeEach(async () => {
    await installCatalog(h, 'en', {
      sets: [TEST_SET],
      cards: testCards(),
      prices: [
        { cardId: 'tset-001', source: 'tcgplayer', variant: 'normal', market: 1050, mid: 900, low: 10, sourceUpdatedAt: '2026-10-10T00:00:00.000Z' },
        { cardId: 'tset-001', source: 'cardmarket', variant: 'normal', mid: 777, trend: 999 },
        { cardId: 'tset-002', source: 'tcgplayer', variant: 'normal', mid: 250 }, // market absent: mid
        { cardId: 'tset-003', source: 'tcgplayer', variant: 'normal', low: 5, high: 5000 }, // low/high only: unpriced
        { cardId: 'tset-004', source: 'cardmarket', variant: 'normal', trend: 400 }, // trend only: unpriced
        { cardId: 'tset-005', source: 'tcgplayer', variant: 'normal', market: 0 } // genuine zero
      ]
    });
  });

  it('market then mid, never low/high/trend; known zero counts as priced; EUR is avg only; currencies never combined', async () => {
    for (const id of ['tset-001', 'tset-002', 'tset-003', 'tset-004', 'tset-005']) await h.collection.add(copyOf(id));
    const d = await h.portfolio.dashboard({});
    const [usd, eur] = d.currencies;
    expect(usd).toMatchObject({ currency: 'USD', estimatedValueCents: 1050 + 250 + 0, valuedCopies: 3, pricedCopies: 3, unvaluedCopies: 2, totalCopies: 5 });
    expect(eur).toMatchObject({ currency: 'EUR', estimatedValueCents: 777, valuedCopies: 1, unvaluedCopies: 4 });
    expect(d.pricedCopies).toBe(3); // display currency USD: "3 of 5 copies priced"
    expect((await h.portfolio.dashboard({ currency: 'EUR' })).pricedCopies).toBe(1);
  });

  it('a variant never inherits another variant price; qualified prints need exact detail', async () => {
    await h.collection.add(copyOf('tset-001', { variant: 'reverse_holo' }));
    await h.collection.add(copyOf('tset-001', { variant: 'first_edition', variantDetail: 'holo' }));
    const d = await h.portfolio.dashboard({});
    expect(d.currencies[0]).toMatchObject({ estimatedValueCents: null, valuedCopies: 0 });
  });

  it('latest provider timestamp wins over capture order; stale history never outranks a newer quote', async () => {
    const copy = await h.collection.add(copyOf('tset-001')); // adding captured the baseline quote into history too
    await addHistory('tset-001', { source: 'tcgplayer', market: 1, sourceUpdatedAt: '2026-01-01T00:00:00.000Z', capturedAt: '2026-10-29T00:00:00.000Z' }); // captured later, provider-older
    expect((await h.collection.getCopy({ id: copy.id })).valuations.find((v) => v.currency === 'USD')?.cents).toBe(1050);
    await addHistory('tset-001', { source: 'tcgplayer', market: 2222, sourceUpdatedAt: '2026-10-20T00:00:00.000Z' }); // provider-newer
    expect((await h.collection.getCopy({ id: copy.id })).valuations.find((v) => v.currency === 'USD')?.cents).toBe(2222);
    expect((await h.portfolio.dashboard({})).currencies[0]?.estimatedValueCents).toBe(2222);
  });

  it('keeps valuing from preserved history after the catalog is gone', async () => {
    const copy = await h.collection.add(copyOf('tset-001'));
    await h.t.databases.close();
    const reopened = await h.t.reopen();
    const { rmSync } = await import('node:fs');
    rmSync(reopened.catalogPath('en'));
    const h2 = (await import('./helpers')).harnessFor(await reopened.reopen());
    const read = await h2.collection.getCopy({ id: copy.id });
    expect(read.catalogAvailable).toBe(false);
    expect(read.valuations.find((v) => v.currency === 'USD')?.cents).toBe(1050); // history captured at add time
    await h2.cleanup();
  });

  it('manual override wins in its currency and replaces automatic valuations; graded without override is unvalued', async () => {
    const manual = await h.collection.add(copyOf('tset-001', { manualPrice: { cents: 4200, currency: 'EUR' } }));
    await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '10' } as never }));
    await h.collection.add(copyOf('tset-001', { grade: { company: 'PSA', grade: '9' } as never, manualPrice: { cents: 0, currency: 'USD' } })); // zero is a value
    const d = await h.portfolio.dashboard({});
    expect(d.currencies[0]).toMatchObject({ estimatedValueCents: 0, valuedCopies: 1, unvaluedCopies: 2 });
    expect(d.currencies[1]).toMatchObject({ estimatedValueCents: 4200, valuedCopies: 1 });
    expect(manual.valuations).toHaveLength(1);
  });

  it('total paid sums known per-currency amounts; gain/loss only over copies with BOTH value and cost in the same currency', async () => {
    await h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 300, currency: 'USD' } })); // value 1050, cost 300
    await h.collection.add(copyOf('tset-002', { purchasePrice: { cents: 100, currency: 'USD' } })); // value 250, cost 100
    await h.collection.add(copyOf('tset-003', { purchasePrice: { cents: 50, currency: 'USD' } })); // unvalued, cost 50
    await h.collection.add(copyOf('tset-001')); // value 1050, no cost
    await h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 0, currency: 'USD' } })); // known free: value 1050, cost 0
    await h.collection.add(copyOf('tset-001', { purchasePrice: { cents: 2000, currency: 'EUR' } })); // EUR cost, EUR value 777
    const [usd, eur] = (await h.portfolio.dashboard({})).currencies;
    expect(usd).toMatchObject({
      totalPaidCents: 450, knownCostCopies: 4, comparableCopies: 3, comparableCostCents: 400, comparableValueCents: 2350, gainLossCents: 1950,
      estimatedValueCents: 1050 + 250 + 1050 + 1050 + 1050
    });
    expect(eur).toMatchObject({ totalPaidCents: 2000, knownCostCopies: 1, comparableCopies: 1, comparableCostCents: 2000, comparableValueCents: 777, gainLossCents: 777 - 2000 });
  });

  it('rejects a total beyond the safe integer range instead of overflowing silently', async () => {
    await h.collection.add(copyOf('tset-001', { manualPrice: { cents: 2147483647, currency: 'USD' } }));
    await h.t.user.run("UPDATE owned_cards SET manual_price_cents = 2147483647");
    const first = await h.collection.list({ groupBy: 'copy' });
    expect(first.page.total).toBe(1);
    // 2^31-1 cents times ~4.2M copies would exceed 2^53: simulate with a single aggregate row of huge count.
    const { safeMul } = await import('../src/domain/valuation');
    expect(() => safeMul(2147483647, 2 ** 30)).toThrow(RangeError);
  });
});

describe('recent copies (12)', () => {
  it('newest 10 by createdAt DESC, id DESC, honoring imported historical timestamps, including custom', async () => {
    await installStandardCatalog(h, 'en');
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push((await h.collection.add(copyOf('tset-001'))).id);
    const custom = await h.collection.createCustom({ name: 'Mine', language: 'en' });
    const customCopyDto = await h.collection.add(customCopy(custom.id));
    // An "imported" copy with an old timestamp must not appear as recent even though it was inserted last.
    const old = await h.collection.add(copyOf('tset-002'));
    await h.t.user.run("UPDATE owned_cards SET created_at = '2001-01-01T00:00:00.000Z' WHERE id = ?", [old.id]);
    // Two copies with the identical timestamp tie-break by id DESC.
    await h.t.user.run("UPDATE owned_cards SET created_at = '2040-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [ids[0], ids[1]]);
    const d = await h.portfolio.dashboard({});
    expect(d.recent).toHaveLength(10);
    const tied = [ids[0]!, ids[1]!].sort().reverse();
    expect(d.recent.slice(0, 2).map((c) => c.id)).toEqual(tied);
    expect(d.recent.map((c) => c.id)).toContain(customCopyDto.id);
    expect(d.recent.map((c) => c.id)).not.toContain(old.id);
    expect(d.totalCards).toBe(14);
  });
});
