import { describe, expect, it } from 'vitest';
import { describeFxCoverage, describeValuationSource, describeValueSource } from './coverage';

const money = (cents: number, cur: 'USD' | 'EUR') => `${cur === 'USD' ? '$' : '€'}${(cents / 100).toFixed(2)}`;

describe('describeFxCoverage', () => {
  it('is silent when no FX is involved', () => {
    expect(describeFxCoverage({ sourcePricedCopies: 5, convertedCopies: 0, fxUnavailableCopies: 0, unvaluedCopies: 1, fxRateDate: null })).toBeNull();
    expect(describeFxCoverage({ unvaluedCopies: 0 })).toBeNull();
  });
  it('lists source-priced · converted (FX date) · unpriced', () => {
    expect(describeFxCoverage({ sourcePricedCopies: 4, convertedCopies: 3, staleFxCopies: 0, fxUnavailableCopies: 0, unvaluedCopies: 2, fxRateDate: '2026-11-06' })).toEqual({
      line: '4 source-priced · 3 converted (FX 2026-11-06) · 2 unpriced', staleBadge: null, unavailable: null
    });
  });
  it('stale badge and unavailable reason', () => {
    const t = describeFxCoverage({ sourcePricedCopies: 0, convertedCopies: 2, staleFxCopies: 2, fxUnavailableCopies: 1, unvaluedCopies: 1, fxRateDate: '2026-10-01' });
    expect(t?.staleBadge).toBe('FX rate from 2026-10-01');
    expect(t?.unavailable).toBe('1 copy has only a Cardmarket price — USD value unavailable (no exchange rate yet)');
    expect(describeFxCoverage({ convertedCopies: 0, fxUnavailableCopies: 3, unvaluedCopies: 3, fxRateDate: null })?.unavailable).toContain('3 copies have only a Cardmarket price');
  });
});

describe('describeValuationSource', () => {
  it('converted: both amounts, rate and date; never labelled TCGplayer', () => {
    expect(describeValuationSource({ source: 'cardmarket', cents: 2389, converted: true, originalCents: 2140, originalCurrency: 'EUR', fxRate: '1.1165', fxRateDate: '2026-11-06' }, money))
      .toBe('Cardmarket €21.40 → $23.89 · ECB rate 1.1165 (2026-11-06)');
  });
  it('native tcgplayer market / mid, EUR avg, manual none', () => {
    expect(describeValuationSource({ source: 'tcgplayer', cents: 500, quoteType: 'market' }, money)).toBe('TCGplayer market $5.00');
    expect(describeValuationSource({ source: 'tcgplayer', cents: 250, quoteType: 'mid' }, money)).toBe('TCGplayer mid $2.50');
    expect(describeValuationSource({ source: 'cardmarket', cents: 2140 }, money)).toBe('Cardmarket avg €21.40');
    expect(describeValuationSource({ source: 'manual', cents: 1 }, money)).toBeNull();
  });
});

describe('describeValueSource (R11-02)', () => {
  it('derives the label from the bucket composition', () => {
    expect(describeValueSource({ sourcePricedCopies: 3, convertedCopies: 0, fxRateDate: '2026-11-06' }, 'USD')).toBe('TCGplayer prices');
    expect(describeValueSource(undefined, 'USD')).toBe('TCGplayer prices');
    expect(describeValueSource({ convertedCopies: 0 }, 'USD')).toBe('TCGplayer prices');
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 2, fxRateDate: '2026-11-06' }, 'USD')).toBe('Cardmarket prices converted to USD (ECB 2026-11-06)');
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 2, fxRateDate: null }, 'USD')).toBe('Cardmarket prices converted to USD');
    expect(describeValueSource({ sourcePricedCopies: 1, convertedCopies: 2, fxRateDate: '2026-11-06' }, 'USD')).toBe('TCGplayer + converted Cardmarket prices');
    expect(describeValueSource({ sourcePricedCopies: 1, convertedCopies: 2 }, 'EUR')).toBe('Cardmarket prices');
  });
  it('never calls an all-converted total TCGplayer', () => {
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 5, fxRateDate: '2026-11-06' }, 'USD')).not.toContain('TCGplayer');
  });
  it('never attributes manual values to a provider (Sol-12 residual R11-02)', () => {
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 0, manualCopies: 2 }, 'USD')).toBe('your manual prices');
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 0, manualCopies: 2 }, 'EUR')).toBe('your manual prices');
    expect(describeValueSource({ sourcePricedCopies: 1, convertedCopies: 0, manualCopies: 2 }, 'USD')).toBe('TCGplayer prices + manual prices');
    expect(describeValueSource({ sourcePricedCopies: 0, convertedCopies: 1, manualCopies: 1, fxRateDate: '2026-11-06' }, 'USD')).toBe('Cardmarket prices converted to USD (ECB 2026-11-06) + manual prices');
    expect(describeValueSource({ sourcePricedCopies: 1, convertedCopies: 1, manualCopies: 1 }, 'USD')).toBe('TCGplayer + converted Cardmarket prices + manual prices');
    expect(describeValueSource({ sourcePricedCopies: 1, convertedCopies: 0, manualCopies: 1 }, 'EUR')).toBe('Cardmarket prices + manual prices');
  });
});
