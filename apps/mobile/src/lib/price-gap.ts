import type { Currency, PriceDto } from '../data';

const COLS: Record<Currency, readonly ('marketCents' | 'trendCents' | 'midCents' | 'lowCents' | 'highCents')[]> = {
  USD: ['marketCents', 'midCents', 'lowCents', 'highCents'],
  EUR: ['trendCents', 'midCents', 'lowCents', 'highCents']
};
const SOURCE: Record<Currency, string> = { USD: 'TCGplayer', EUR: 'Cardmarket' };

export type PriceGap = { missing: Currency; other: Currency; cents: number; source: string; asOf: string | null };

/** The headline number of one price row for a currency, or null when the row has none. */
function headline(row: PriceDto, currency: Currency): number | null {
  for (const col of COLS[currency]) {
    const value = row[col];
    if (typeof value === 'number' && value > 0) return value;
  }
  return null;
}

/** True when the tab's currency has at least one usable price. */
export function hasCurrencyPrice(prices: readonly PriceDto[], currency: Currency): boolean {
  return prices.some((p) => p.currency === currency && headline(p, currency) !== null);
}

/**
 * Price gap (Grok Naming): the selected currency has no price but the other one does. Returns the other currency's
 * headline amount with its source and date, so the details screen can say "No USD price" and still show the euro number.
 * Never converts and never returns a zero amount.
 */
export function priceGap(prices: readonly PriceDto[], tab: Currency): PriceGap | null {
  if (hasCurrencyPrice(prices, tab)) return null;
  const other: Currency = tab === 'USD' ? 'EUR' : 'USD';
  const rows = prices.filter((p) => p.currency === other);
  const best = rows
    .map((row) => ({ row, cents: headline(row, other) }))
    .filter((x): x is { row: PriceDto; cents: number } => x.cents !== null)
    .sort((a, b) => (b.row.sourceUpdatedAt ?? b.row.capturedAt ?? '').localeCompare(a.row.sourceUpdatedAt ?? a.row.capturedAt ?? ''))[0];
  if (!best) return null;
  return { missing: tab, other, cents: best.cents, source: SOURCE[other], asOf: best.row.sourceUpdatedAt ?? best.row.capturedAt ?? null };
}
