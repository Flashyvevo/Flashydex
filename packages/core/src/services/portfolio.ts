import { DashboardInput, type Currency, type CurrencyStats, type DashboardDto, type Input, type OwnedDto } from '@flashydex/schemas';
import { tryConvertCents } from '../domain/fx';
import { resolveUsd, valuationsFor, valueIn, safeAdd, safeMul } from '../domain/valuation';
import { ValidationError } from '../errors';
import { fxFor, identityKey, loadQuotes, parse, readSettings, type ServiceContext } from './context';
import { hydrateOwned } from './owned-read';

type Bucket = {
  currency: Currency; valuedCopies: number; value: number; paidCopies: number; paid: number; comparableCopies: number; comparableCost: number; comparableValue: number;
};

/** USD-only FX accounting (Pricing v2). Each physical copy lands in exactly one of sourcePriced / converted / unpriced. */
type FxStats = { sourcePriced: number; converted: number; convertedValue: number; staleFx: number; fxUnavailable: number; costConverted: number };

/** DATA-MODEL "Definitions for every screen and aggregate". Whole collection: no Pocket/filter exclusions. */
export class PortfolioService {
  constructor(private readonly ctx: ServiceContext) {}

  async dashboard(input: Input<typeof DashboardInput> = {}): Promise<DashboardDto> {
    parse(DashboardInput, input);
    // E2 / N07 + E04: one consistent read. The personal revision AND catalog generations are captured before and after; if either moved
    // (aggregates read, then a write, then recent-row hydration) the whole dashboard is recomputed once, then STALE_READ.
    return this.ctx.databases.consistentRead(['en', 'ja'], () => this.dashboardOnce(input));
  }

  private async dashboardOnce(input: Input<typeof DashboardInput> = {}): Promise<DashboardDto> {
    const { currency } = parse(DashboardInput, input);
    const user = this.ctx.databases.user;
    const settings = await user.read((r) => readSettings(r));
    const displayCurrency: Currency = currency ?? settings.defaultCurrency;

    const { totalCopies, uniqueCards, duplicates, aggregates, recentIds } = await user.read(async (q) => {
      const total = Number((await q.scalar<number>('SELECT COUNT(*) FROM owned_cards')) ?? 0);
      const groups = await q.rows('SELECT COUNT(*), COALESCE(SUM(n - 1), 0) FROM (SELECT COUNT(*) AS n FROM owned_cards GROUP BY language, catalog_card_id, custom_card_id, variant, variant_detail)');
      // Copies sharing identity/variant/detail/grade-state/manual value/cost currency have the same automatic value: aggregate them.
      const agg = await q.select<{
        language: 'en' | 'ja'; catalogCardId: string | null; variant: string; variantDetail: string; graded: number; manualCents: number | null;
        manualCurrency: Currency | null; costCurrency: Currency | null; n: number; costCopies: number; costSum: number | null;
      }>(
        {
          language: 'o.language', catalogCardId: 'o.catalog_card_id', variant: 'o.variant', variantDetail: 'o.variant_detail',
          graded: 'EXISTS (SELECT 1 FROM grades g WHERE g.owned_card_id = o.id)', manualCents: 'o.manual_price_cents', manualCurrency: 'o.manual_price_currency',
          costCurrency: 'o.purchase_currency', n: 'COUNT(*)', costCopies: 'COUNT(o.purchase_price_cents)', costSum: 'SUM(o.purchase_price_cents)'
        },
        'FROM owned_cards o GROUP BY o.language, o.catalog_card_id, o.variant, o.variant_detail, graded, o.manual_price_cents, o.manual_price_currency, o.purchase_currency'
      );
      const recent = await q.rows('SELECT id FROM owned_cards ORDER BY created_at DESC, id DESC LIMIT 10');
      return {
        totalCopies: total, uniqueCards: Number(groups[0]?.[0] ?? 0), duplicates: Number(groups[0]?.[1] ?? 0), aggregates: agg,
        recentIds: recent.map((r) => String(r[0]))
      };
    });

    const quotes = await loadQuotes(this.ctx, aggregates.filter((a) => a.catalogCardId !== null).map((a) => ({ language: a.language, id: a.catalogCardId as string })));
    const fx = fxFor(this.ctx);
    const fxStats: FxStats = { sourcePriced: 0, converted: 0, convertedValue: 0, staleFx: 0, fxUnavailable: 0, costConverted: 0 };
    const buckets: Record<Currency, Bucket> = {
      USD: { currency: 'USD', valuedCopies: 0, value: 0, paidCopies: 0, paid: 0, comparableCopies: 0, comparableCost: 0, comparableValue: 0 },
      EUR: { currency: 'EUR', valuedCopies: 0, value: 0, paidCopies: 0, paid: 0, comparableCopies: 0, comparableCost: 0, comparableValue: 0 }
    };
    try {
      for (const a of aggregates) {
        const n = Number(a.n);
        const manual = a.manualCents !== null && a.manualCurrency !== null ? { cents: Number(a.manualCents), currency: a.manualCurrency } : null;
        const graded = Number(a.graded) === 1;
        const identityQuotes = a.catalogCardId === null ? [] : (quotes.get(identityKey(a.language, a.catalogCardId)) ?? []);
        const valuations = valuationsFor({ variant: a.variant, variantDetail: a.variantDetail, graded, manual, updatedAt: '' }, identityQuotes, fx);
        const usdValuation = valuations.find((v) => v.currency === 'USD');
        if (usdValuation) {
          if (usdValuation.converted) {
            fxStats.converted += n;
            fxStats.convertedValue = safeAdd(fxStats.convertedValue, safeMul(usdValuation.cents, n));
            if (usdValuation.stale) fxStats.staleFx += n;
          } else fxStats.sourcePriced += n;
        } else if (!manual && !graded && resolveUsd(identityQuotes, a.variant, a.variantDetail, fx).kind === 'fx_unavailable') {
          fxStats.fxUnavailable += n;
        }
        for (const c of ['USD', 'EUR'] as const) {
          const b = buckets[c];
          const unit = valueIn(valuations, c);
          if (unit !== null) { b.valuedCopies += n; b.value = safeAdd(b.value, safeMul(unit, n)); }
          if (a.costCurrency === c && a.costSum !== null) {
            const costCopies = Number(a.costCopies);
            b.paidCopies += costCopies;
            b.paid = safeAdd(b.paid, Number(a.costSum));
            if (unit !== null) {
              b.comparableCopies += costCopies;
              b.comparableCost = safeAdd(b.comparableCost, Number(a.costSum));
              b.comparableValue = safeAdd(b.comparableValue, safeMul(unit, costCopies));
            }
          } else if (c === 'USD' && a.costCurrency === 'EUR' && a.costSum !== null && unit !== null && fx) {
            // EUR cost vs USD value: convert the cost with the SAME FX record as the value (one rounding per aggregate group). Not added to totalPaid.
            const convertedCost = tryConvertCents(Number(a.costSum), fx.record.rate);
            if (convertedCost !== null) {
              const costCopies = Number(a.costCopies);
              b.comparableCopies += costCopies;
              b.comparableCost = safeAdd(b.comparableCost, convertedCost);
              b.comparableValue = safeAdd(b.comparableValue, safeMul(unit, costCopies));
              fxStats.costConverted += costCopies;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof RangeError) throw new ValidationError('A total exceeds the supported range', [{ path: '', code: 'too_big', message: error.message }]);
      throw error;
    }

    const stats = (c: Currency): CurrencyStats => {
      const b = buckets[c];
      const fxExtra: Partial<CurrencyStats> = c === 'USD' && totalCopies > 0
        ? {
            sourcePricedCopies: fxStats.sourcePriced, convertedCopies: fxStats.converted, convertedValueCents: fxStats.convertedValue, staleFxCopies: fxStats.staleFx,
            fxUnavailableCopies: fxStats.fxUnavailable, costConvertedCopies: fxStats.costConverted, fxRateDate: fx?.record.rateDate ?? null
          }
        : {};
      return {
        currency: c,
        estimatedValueCents: b.valuedCopies > 0 ? b.value : null,
        pricedCopies: b.valuedCopies, totalCopies, valuedCopies: b.valuedCopies, unvaluedCopies: totalCopies - b.valuedCopies,
        totalPaidCents: b.paidCopies > 0 ? b.paid : null, knownCostCopies: b.paidCopies, comparableCopies: b.comparableCopies,
        comparableCostCents: b.comparableCopies > 0 ? b.comparableCost : null, comparableValueCents: b.comparableCopies > 0 ? b.comparableValue : null,
        gainLossCents: b.comparableCopies > 0 ? b.comparableValue - b.comparableCost : null,
        ...fxExtra
      };
    };
    const hydrated = await hydrateOwned(this.ctx, recentIds);
    return {
      totalCards: totalCopies, totalCopies, uniqueCards, duplicates, displayCurrency, pricedCopies: buckets[displayCurrency].valuedCopies,
      currencies: [stats('USD'), stats('EUR')],
      recent: recentIds.map((id) => hydrated.get(id)).filter((c): c is OwnedDto => c !== undefined)
    };
  }
}
