import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseTcgdexPricing, TCGDEX_PROVIDER } from '../src/pricing/tcgdex-normalise';
import type { MarketQuote } from '../src/pricing/types';

interface Fixture { language: 'en' | 'ja'; id: string; pricing: unknown }
const load = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/tcgdex/${name}.json`, import.meta.url), 'utf8')) as Fixture;
const OBSERVED = '2026-11-08T12:00:00.000Z';
const run = (name: string): MarketQuote[] => {
  const f = load(name);
  return normaliseTcgdexPricing(f.pricing, { language: f.language, cardId: f.id, observedAt: OBSERVED });
};
const find = (quotes: MarketQuote[], variant: string, type: string, detail = ''): MarketQuote | undefined =>
  quotes.find((q) => q.cardIdentity.variant === variant && q.cardIdentity.variantDetail === detail && q.quoteType === type);

const FIXTURES = ['pricing-en-swsh3-136', 'pricing-en-sv01-001', 'pricing-en-base1-4', 'pricing-en-xy1-1', 'pricing-ja-SV1S-001'];

describe('normaliseTcgdexPricing (real TCGdex payloads)', () => {
  it('swsh3-136: tcgplayer per-variant fields are listing estimates in USD cents', () => {
    const q = run('pricing-en-swsh3-136');
    const market = find(q, 'normal', 'market');
    expect(market).toMatchObject({ provider: TCGDEX_PROVIDER, kind: 'provider-sale-average', methodology: 'provider-unspecified', currency: 'USD', cents: 30, providerUpdatedAt: '2026-11-07T23:49:29.372Z', observedAt: OBSERVED });
    expect(market?.cardIdentity).toEqual({ language: 'en', cardId: 'swsh3-136', variant: 'normal', variantDetail: '' });
    expect(find(q, 'normal', 'mid')?.cents).toBe(28);
    expect(find(q, 'normal', 'low')?.cents).toBe(2);
    expect(find(q, 'normal', 'high')?.cents).toBe(2529);
    expect(find(q, 'normal', 'directLow')?.cents).toBe(9);
    expect(find(q, 'reverse_holo', 'market')?.cents).toBe(43);
    expect(find(q, 'reverse_holo', 'directLow')?.cents).toBe(25);
  });

  it('swsh3-136: cardmarket avg1/avg7/avg30/avg are provider-sale-average; low/trend are listing estimates', () => {
    const q = run('pricing-en-swsh3-136');
    for (const [type, cents] of [['avg', 6], ['avg1', 8], ['avg7', 7], ['avg30', 6]] as const) {
      expect(find(q, 'cardmarket-nonfoil', type)).toMatchObject({ kind: 'provider-sale-average', currency: 'EUR', cents, providerUpdatedAt: '2026-11-07T23:49:17.885Z' });
    }
    expect(find(q, 'cardmarket-foil', 'avg7')).toMatchObject({ kind: 'provider-sale-average', cents: 27 });
    expect(find(q, 'cardmarket-foil', 'avg30')?.cents).toBe(26);
    expect(find(q, 'cardmarket-nonfoil', 'low')).toMatchObject({ kind: 'listing-estimate', cents: 2 });
    expect(find(q, 'cardmarket-nonfoil', 'trend')).toMatchObject({ kind: 'listing-estimate', cents: 9 });
  });

  it('base1-4: null cardmarket foil fields yield no quote; single tcgplayer holofoil key', () => {
    const q = run('pricing-en-base1-4');
    expect(find(q, 'cardmarket-foil', 'avg')).toBeUndefined();
    expect(find(q, 'cardmarket-foil', 'low')).toBeUndefined();
    expect(find(q, 'cardmarket-foil', 'trend')?.cents).toBe(12363);
    expect(find(q, 'cardmarket-nonfoil', 'avg')?.cents).toBe(45810);
    expect(find(q, 'holo', 'market')).toMatchObject({ cents: 98713, currency: 'USD', kind: 'provider-sale-average', methodology: 'provider-unspecified' });
    expect(find(q, 'holo', 'directLow')?.cents).toBe(149909);
    expect(q.filter((x) => x.currency === 'USD').every((x) => x.cardIdentity.variant === 'holo')).toBe(true);
  });

  it('sv01-001: null directLowPrice produces no directLow quote', () => {
    const q = run('pricing-en-sv01-001');
    expect(find(q, 'normal', 'directLow')).toBeUndefined();
    expect(find(q, 'reverse_holo', 'directLow')).toBeUndefined();
    expect(find(q, 'normal', 'market')?.cents).toBe(11);
  });

  it('xy1-1: tcgplayer holofoil prices attach to the holo variant even though the card lists normal', () => {
    const q = run('pricing-en-xy1-1');
    expect(find(q, 'holo', 'market')?.cents).toBe(703);
    expect(find(q, 'cardmarket-nonfoil', 'avg7')?.cents).toBe(1215);
  });

  it('ja SV1S-001: no tcgplayer block; cardmarket 0 ("no data") and null are dropped; real values kept', () => {
    const f = load('pricing-ja-SV1S-001');
    expect((f.pricing as { tcgplayer: unknown }).tcgplayer).toBeNull();
    const q = run('pricing-ja-SV1S-001');
    expect(q.every((x) => x.currency === 'EUR')).toBe(true);
    expect(find(q, 'cardmarket-foil', 'trend')).toBeUndefined(); // trend-holo: 0
    expect(find(q, 'cardmarket-foil', 'avg7')).toBeUndefined(); // null
    expect(find(q, 'cardmarket-nonfoil', 'avg7')).toMatchObject({ cents: 14, kind: 'provider-sale-average' });
    expect(q[0]?.cardIdentity.language).toBe('ja');
  });

  it.each(FIXTURES)('%s: kind invariants hold for every quote', (name) => {
    const q = run(name);
    expect(q.length).toBeGreaterThan(0);
    for (const quote of q) {
      expect(quote.kind).not.toBe('verified-sale'); // a relayed aggregate is never a verified sale
      expect(Number.isInteger(quote.cents) && quote.cents > 0).toBe(true);
      if (quote.cardIdentity.variant.startsWith('cardmarket')) {
        expect(quote.kind).toBe(['avg', 'avg1', 'avg7', 'avg30'].includes(quote.quoteType) ? 'provider-sale-average' : 'listing-estimate');
      } else {
        expect(quote.kind).toBe(quote.quoteType === 'market' ? 'provider-sale-average' : 'listing-estimate');
        expect(quote.methodology).toBe(quote.quoteType === 'market' ? 'provider-unspecified' : undefined);
      }
    }
  });

  it('is deterministic and drops blocks in an unexpected unit instead of relabelling them', () => {
    expect(run('pricing-en-swsh3-136')).toEqual(run('pricing-en-swsh3-136'));
    const f = load('pricing-en-swsh3-136');
    const pricing = f.pricing as { cardmarket: Record<string, unknown>; tcgplayer: Record<string, unknown> };
    const mutated = { cardmarket: { ...pricing.cardmarket, unit: 'USD' }, tcgplayer: { ...pricing.tcgplayer, unit: 'EUR' } };
    expect(normaliseTcgdexPricing(mutated, { language: 'en', cardId: f.id, observedAt: OBSERVED })).toEqual([]);
  });

  it('tolerates missing/garbage input', () => {
    const opts = { language: 'en', cardId: 'x', observedAt: OBSERVED } as const;
    for (const input of [null, undefined, 5, 'x', [], {}, { cardmarket: null, tcgplayer: null }, { tcgplayer: { unit: 'USD', normal: { marketPrice: 'abc', lowPrice: -1 } } }]) {
      expect(normaliseTcgdexPricing(input, opts)).toEqual([]);
    }
  });
});

describe('TCGplayer market classification (R11-05)', () => {
  it('market = provider-sale-average + provider-unspecified; low/mid/high/directLow stay listing-estimate without methodology', () => {
    const q = run('pricing-en-swsh3-136').filter((x) => x.provider === TCGDEX_PROVIDER && x.currency === 'USD');
    expect(q.length).toBeGreaterThan(0);
    for (const quote of q) {
      if (quote.quoteType === 'market') {
        expect(quote.kind).toBe('provider-sale-average');
        expect(quote.methodology).toBe('provider-unspecified');
      } else {
        expect(quote.kind).toBe('listing-estimate');
        expect(quote.methodology).toBeUndefined();
      }
      expect(quote.kind).not.toBe('verified-sale');
    }
  });
  it('Cardmarket quotes carry no methodology field', () => {
    for (const quote of run('pricing-en-swsh3-136').filter((x) => x.currency === 'EUR')) expect('methodology' in quote).toBe(false);
  });
});
