/** Pure UI wording for the FX coverage line (dashboard). Kept out of the component so the strings are unit-tested. */
export type FxCoverageStats = {
  sourcePricedCopies?: number;
  manualCopies?: number;
  convertedCopies?: number;
  staleFxCopies?: number;
  fxUnavailableCopies?: number;
  unvaluedCopies: number;
  fxRateDate?: string | null;
};

export type FxCoverageText = { line: string; staleBadge: string | null; unavailable: string | null };

/** Null when no FX is involved at all (nothing converted, nothing blocked) — the existing coverage line stands alone. */
export function describeFxCoverage(s: FxCoverageStats): FxCoverageText | null {
  const converted = s.convertedCopies ?? 0;
  const blocked = s.fxUnavailableCopies ?? 0;
  if (converted === 0 && blocked === 0) return null;
  const source = s.sourcePricedCopies ?? 0;
  const convertedPart = s.fxRateDate ? `${converted} converted (FX ${s.fxRateDate})` : `${converted} converted`;
  return {
    line: `${source} source-priced · ${convertedPart} · ${s.unvaluedCopies} unpriced`,
    staleBadge: (s.staleFxCopies ?? 0) > 0 && s.fxRateDate ? `FX rate from ${s.fxRateDate}` : null,
    unavailable: blocked > 0 ? `${blocked} ${blocked === 1 ? 'copy has' : 'copies have'} only a Cardmarket price — USD value unavailable (no exchange rate yet)` : null
  };
}

/** One-line card-detail source text for a valuation, or null for manual values. */
export type ValuationSource = {
  source: 'manual' | 'tcgplayer' | 'cardmarket';
  cents: number;
  converted?: boolean;
  originalCents?: number;
  originalCurrency?: string;
  fxRate?: string;
  fxRateDate?: string;
  quoteType?: 'market' | 'mid' | 'avg';
  stale?: boolean;
};

export function describeValuationSource(v: ValuationSource, money: (cents: number, currency: 'USD' | 'EUR') => string | null): string | null {
  if (v.source === 'manual') return null;
  if (v.converted && v.originalCents !== undefined) {
    return `Cardmarket ${money(v.originalCents, 'EUR')} → ${money(v.cents, 'USD')} · ECB rate ${v.fxRate} (${v.fxRateDate})`;
  }
  if (v.source === 'tcgplayer') return `TCGplayer ${v.quoteType === 'mid' ? 'mid' : 'market'} ${money(v.cents, 'USD')}`;
  return `Cardmarket avg ${money(v.cents, 'EUR')}`;
}

/**
 * Source attribution for a currency's total, derived from the bucket composition (never assumed):
 * all source-priced → TCGplayer; all converted → Cardmarket converted with the ECB date; mixed → both; EUR → Cardmarket.
 */
export function describeValueSource(s: Pick<FxCoverageStats, 'sourcePricedCopies' | 'manualCopies' | 'convertedCopies' | 'fxRateDate'> | undefined, currency: 'USD' | 'EUR'): string {
  const manual = s?.manualCopies ?? 0;
  const converted = s?.convertedCopies ?? 0;
  const source = s?.sourcePricedCopies ?? 0;
  const parts: string[] = [];
  if (currency === 'EUR') {
    // EUR automatic values are always Cardmarket; only an all-manual EUR total has no provider.
    if (source > 0 || converted > 0 || manual === 0) parts.push('Cardmarket prices');
  } else {
    if (source > 0 && converted > 0) parts.push('TCGplayer + converted Cardmarket prices');
    else if (source > 0) parts.push('TCGplayer prices');
    else if (converted > 0) parts.push(s?.fxRateDate ? `Cardmarket prices converted to USD (ECB ${s.fxRateDate})` : 'Cardmarket prices converted to USD');
    else if (manual === 0) parts.push('TCGplayer prices');
  }
  if (manual > 0) parts.push(parts.length === 0 ? 'your manual prices' : 'manual prices');
  return parts.join(' + ');
}
