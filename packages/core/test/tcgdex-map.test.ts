import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  classifyPrint, encodeIdForPath, localIdSort, mapCard, mapSet, mapSetIndexEntry, nameSearch, normalizeStamp, parseCents,
  printAttributes, sha256Hex, symbolUrl, variantKey, type MapContext, type RawCard, type RawSetDetail
} from '../src/catalog/tcgdex';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/tcgdex/${name}`, import.meta.url), 'utf8')) as T;
const en: MapContext = { language: 'en', syncedAt: '2026-10-31T00:00:00.000Z' };
const ja: MapContext = { language: 'ja', syncedAt: '2026-10-31T00:00:00.000Z' };

const priceSummary = (mapped: ReturnType<typeof mapCard>) =>
  mapped.prices.map((p) => `${p.source}|${p.variant}|${p.variantDetail}|${p.providerVariantKey}|${p.lowCents}/${p.midCents}/${p.highCents}/${p.marketCents}/${p.trendCents}`);

describe('sha256Hex (pure)', () => {
  it('matches node:crypto for ASCII, multi-block and non-ASCII input', () => {
    for (const text of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'フシギダネ ✓']) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });
});

describe('parseCents (decimal half-up)', () => {
  it.each([
    [0.27, 27], [458.1, 45810], [1.005, 101], [0.285, 29], [0.0049, 0], [0.005, 1], [19.99, 1999], [0, 0], [1e-7, 0], [25.27, 2527],
    ['3.5', 350], [1234567.891, 123456789]
  ])('%s -> %s cents', (input, cents) => {
    expect(parseCents(input)).toEqual({ cents, warning: null });
  });
  it('keeps absent as null without warning and flags bad values', () => {
    expect(parseCents(null)).toEqual({ cents: null, warning: null });
    expect(parseCents(undefined)).toEqual({ cents: null, warning: null });
    expect(parseCents(-1)).toEqual({ cents: null, warning: 'negative' });
    expect(parseCents(Number.NaN)).toEqual({ cents: null, warning: 'invalid' });
    expect(parseCents('abc')).toEqual({ cents: null, warning: 'invalid' });
    expect(parseCents(1e12)).toEqual({ cents: null, warning: 'overflow' });
    expect(parseCents(21474836.47)).toEqual({ cents: 2147483647, warning: null });
  });
});

describe('text helpers', () => {
  it('derives search/sort keys and rewrites univ symbols', () => {
    expect(nameSearch('Ｐikachu ＶMAX')).toBe('pikachu vmax');
    expect(localIdSort('SWSH001')).toBe('SWSH000000000001');
    expect(localIdSort('50a')).toBe('000000000050a');
    expect(localIdSort('001')).toBe('000000000001');
    expect(normalizeStamp('1st edition')).toBe('1st-edition');
    expect(symbolUrl('https://assets.tcgdex.net/univ/swsh/swsh3/symbol', 'en')).toBe('https://assets.tcgdex.net/en/swsh/swsh3/symbol.webp');
    expect(symbolUrl('https://assets.tcgdex.net/univ/neo/neo1/symbol', 'ja')).toBe('https://assets.tcgdex.net/ja/neo/neo1/symbol.webp');
    expect(symbolUrl(undefined, 'ja')).toBeNull();
    expect(encodeIdForPath('SM1+')).toBe('SM1%2B');
    expect(encodeIdForPath('exu-%3F')).toBe('exu-%253F');
  });
});

describe('variant classification (DATA-MODEL binding table)', () => {
  const classify = (row: Record<string, unknown>) => classifyPrint(printAttributes(row));
  it('maps plain and qualified prints', () => {
    expect(classify({ type: 'normal', size: 'standard' })).toEqual({ variant: 'normal', variantDetail: '' });
    expect(classify({ type: 'holo', size: 'standard' })).toEqual({ variant: 'holo', variantDetail: '' });
    expect(classify({ type: 'reverse', size: 'standard' })).toEqual({ variant: 'reverse_holo', variantDetail: '' });
    expect(classify({ type: 'reverse', foil: 'pokeball', size: 'standard' })).toEqual({ variant: 'reverse_holo', variantDetail: 'pokeball' });
    expect(classify({ type: 'reverse', foil: 'masterball', size: 'standard' })).toEqual({ variant: 'reverse_holo', variantDetail: 'masterball' });
    expect(classify({ type: 'holo', foil: 'gold', size: 'standard' })).toEqual({ variant: 'holo', variantDetail: 'gold' });
    expect(classify({ type: 'holo', subtype: 'unlimited', size: 'standard' })).toEqual({ variant: 'holo', variantDetail: 'unlimited' });
    expect(classify({ type: 'holo', stamp: ['1st-edition'], size: 'standard' })).toEqual({ variant: 'first_edition', variantDetail: 'holo' });
    expect(classify({ type: 'normal', stamp: ['1st edition'], size: 'standard' })).toEqual({ variant: 'first_edition', variantDetail: 'normal' });
    expect(classify({ type: 'holo', subtype: 'shadowless', stamp: ['1st-edition'], size: 'standard' })).toEqual({ variant: 'first_edition', variantDetail: 'shadowless:holo' });
    expect(classify({ type: 'holo', subtype: 'shadowless', size: 'standard' })).toEqual({ variant: 'shadowless', variantDetail: 'holo' });
    expect(classify({ type: 'holo', stamp: ['Staff', 'set-logo'], size: 'standard' })).toEqual({ variant: 'promo_stamped', variantDetail: 'set-logo,staff' });
    expect(classify({ type: 'holo', stamp: ['25th-celebration'], size: 'jumbo' })).toEqual({ variant: 'promo_stamped', variantDetail: '25th-celebration,jumbo' });
    expect(classify({ type: 'holo', stamp: ['1st-edition-error'], size: 'standard' })).toEqual({ variant: 'promo_stamped', variantDetail: '1st-edition-error' });
    expect(classify({ type: 'holo', subtype: '1999-2000-copyright', size: 'standard' })).toEqual({ variant: 'other', variantDetail: '1999-2000-copyright' });
    expect(classify({ type: 'normal', size: 'jumbo' })).toEqual({ variant: 'other', variantDetail: 'jumbo' });
    expect(classify({ type: 'foo', size: 'standard' })).toEqual({ variant: 'other', variantDetail: 'foo' });
  });
  it('variant_key ignores stamp order/case and the provider variantId', () => {
    const a = variantKey(printAttributes({ type: 'holo', stamp: ['Staff', 'set-logo'], size: 'standard', variantId: 'x' }));
    const b = variantKey(printAttributes({ type: 'holo', stamp: ['set-logo', 'staff'], size: 'standard', variantId: 'y' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(variantKey(printAttributes({ type: 'holo', size: 'standard' }))).toBe(
      createHash('sha256').update('["holo",null,null,"standard",[]]').digest('hex')
    );
  });
});

describe('mapCard: swsh3-136 (EN, two prints, both markets)', () => {
  const mapped = mapCard(fixture<RawCard>('en-card-swsh3-136.json'), en);
  it('maps the card row', () => {
    expect(mapped.card).toMatchObject({
      language: 'en', id: 'swsh3-136', setId: 'swsh3', localId: '136', localIdSort: '000000000136', name: 'Furret', nameSearch: 'furret',
      rarity: 'Uncommon', category: 'Pokemon', imageUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/136',
      hasNormal: true, hasHolo: false, hasReverse: true, hasFirstEdition: false, wPromo: false, detailSyncedAt: en.syncedAt
    });
    expect(JSON.parse(mapped.card.availableVariantsJson)).toEqual(['normal', 'reverse_holo']);
    expect(JSON.parse(mapped.card.rawJson).id).toBe('swsh3-136');
  });
  it('maps both prints by type, not by array order or variantId', () => {
    expect(mapped.variants.map((v) => `${v.variant}|${v.variantDetail}`)).toEqual(['normal|', 'reverse_holo|']);
    expect(new Set(mapped.variants.map((v) => v.variantKey)).size).toBe(2);
    expect(mapped.variants[0]!.providerVariantId).toBe('endfynwn4n10gzq');
  });
  it('picks price keys by name with integer cents', () => {
    const rows = priceSummary(mapped);
    expect(rows).toContain('tcgplayer|normal||219333:normal:|2/25/2527/27/null');
    expect(rows).toContain('tcgplayer|reverse_holo||219333:reverse-holofoil:|17/43/1980/44/null');
    expect(rows).toContain('cardmarket|normal||483559:avg:|2/6/null/null/4');
    expect(rows).toContain('cardmarket|reverse_holo||483559:avg-holo:|8/22/null/null/23');
    expect(rows).toHaveLength(4);
    const tcg = mapped.prices.find((p) => p.source === 'tcgplayer' && p.variant === 'normal')!;
    expect(tcg).toMatchObject({ currency: 'USD', capturedAt: en.syncedAt });
    expect(tcg.sourceUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(tcg.observationKey).toBe(tcg.id);
    expect(tcg.observationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(mapped.warnings).toEqual([]);
  });
  it('is deterministic', () => {
    expect(mapCard(fixture<RawCard>('en-card-swsh3-136.json'), en)).toEqual(mapped);
  });
});

describe('mapCard: JA card with pokeball/masterball reverse prints (SV2a-001)', () => {
  const mapped = mapCard(fixture<RawCard>('ja-card-SV2a-001.json'), ja);
  it('keeps JA identity and ball foils as reverse_holo qualifiers', () => {
    expect(mapped.card).toMatchObject({ language: 'ja', id: 'SV2a-001', name: 'フシギダネ', nameSearch: 'フシギダネ', localId: '001' });
    expect(mapped.variants.map((v) => `${v.variant}|${v.variantDetail}`)).toEqual(['normal|', 'reverse_holo|masterball', 'reverse_holo|pokeball']);
  });
  it('uses EUR only (no fabricated USD), avg-holo for ball prints, exact cents', () => {
    const rows = priceSummary(mapped);
    expect(rows).toEqual([
      'cardmarket|normal||719442:avg:|2/124/null/null/2',
      'cardmarket|reverse_holo|masterball|837231:avg-holo:masterball|950/3400/null/null/8983',
      'cardmarket|reverse_holo|pokeball|837230:avg-holo:pokeball|15/159/null/null/107'
    ]);
    expect(mapped.prices.every((p) => p.currency === 'EUR' && p.source === 'cardmarket')).toBe(true);
  });
});

describe('mapCard: EN pokeball + masterball on a card with USD (sv08.5-001)', () => {
  it('maps ball prints to holofoil on THEIR product, plain reverse to reverse-holofoil on the base product', () => {
    const rows = priceSummary(mapCard(fixture<RawCard>('en-card-sv08.5-001.json'), en)).filter((r) => r.startsWith('tcgplayer'));
    expect(rows).toEqual([
      'tcgplayer|normal||610356:normal:|1/15/99900/9/null',
      'tcgplayer|reverse_holo||610356:reverse-holofoil:|1/20/99900/20/null',
      'tcgplayer|reverse_holo|masterball|610637:holofoil:masterball|25/150/99900/108/null',
      'tcgplayer|reverse_holo|pokeball|610536:holofoil:pokeball|9/36/99900/35/null'
    ]);
  });
});

describe('mapCard: WotC prints (base1-4, neo1-9)', () => {
  it('splits unlimited / 1st-edition shadowless / shadowless / copyright; no invented prices', () => {
    const mapped = mapCard(fixture<RawCard>('en-card-base1-4.json'), en);
    expect(mapped.variants.map((v) => `${v.variant}|${v.variantDetail}`)).toEqual([
      'holo|unlimited', 'first_edition|shadowless:holo', 'shadowless|holo', 'other|1999-2000-copyright'
    ]);
    const rows = priceSummary(mapped);
    // shadowless 1st + shadowless share product 660224: same price, never split; copyright print has no price at all
    expect(rows).toContain('cardmarket|first_edition|shadowless:holo|660224:avg:shadowless:holo|98000/340000/null/null/384313');
    expect(rows).toContain('cardmarket|shadowless|holo|660224:avg:holo|98000/340000/null/null/384313');
    expect(rows).toContain('cardmarket|holo|unlimited|273699:avg:unlimited|9900/45810/null/null/49757');
    expect(rows.some((r) => r.includes('1999-2000-copyright'))).toBe(false);
    // shadowless rows have a product id but a null tcgplayer price object -> no USD row
    expect(rows.filter((r) => r.startsWith('tcgplayer') && /shadowless/.test(r))).toEqual([]);
  });
  it('takes 1st-edition-holofoil BY NAME on a row that also carries unlimited-holofoil', () => {
    const mapped = mapCard(fixture<RawCard>('en-card-neo1-9.json'), en);
    const usd = mapped.prices.filter((p) => p.source === 'tcgplayer');
    expect(usd).toHaveLength(1);
    expect(usd[0]).toMatchObject({ variant: 'first_edition', variantDetail: 'holo', marketCents: 130000, midCents: 900000 });
    expect(usd[0]!.providerVariantKey).toBe('86903:1st-edition-holofoil:holo');
  });
});

describe('mapCard: gaps are nulls, never fabricated', () => {
  it('stores a nullable image (mep-001) and stamped prints with EUR only', () => {
    const mapped = mapCard(fixture<RawCard>('en-card-mep-001.json'), en);
    expect(mapped.card.imageUrl).toBeNull();
    expect(mapped.variants.map((v) => `${v.variant}|${v.variantDetail}`)).toEqual(['promo_stamped|set-logo', 'promo_stamped|set-logo,staff']);
    expect(mapped.prices.map((p) => p.currency)).toEqual(['EUR', 'EUR']);
  });
  it('maps a card with no pricing at all (TCG Pocket A1-001) to one variant and zero prices', () => {
    const mapped = mapCard(fixture<RawCard>('en-card-A1-001.json'), en);
    expect(mapped.variants).toHaveLength(1);
    expect(mapped.prices).toEqual([]);
    expect(mapped.card.imageUrl).toContain('/tcgp/A1/001');
  });
  it('treats gold foil as holo+gold on the holofoil key', () => {
    const rows = priceSummary(mapCard(fixture<RawCard>('en-card-swsh3-201.json'), en));
    expect(rows).toContain('tcgplayer|holo|gold|219325:holofoil:gold|200/292/3900/242/null');
    expect(rows.some((r) => r.startsWith('cardmarket|holo|gold|483894:avg:gold|'))).toBe(true);
  });
  it('nulls rarity when the provider sends null and warns on invalid prices', () => {
    const raw = fixture<RawCard>('en-card-swsh3-136.json');
    const broken = structuredClone(raw) as RawCard;
    broken.rarity = null;
    (broken.variants_detailed![0] as { pricing: { tcgplayer: { normal: { marketPrice: number } } } }).pricing.tcgplayer.normal.marketPrice = -5;
    const mapped = mapCard(broken, en);
    expect(mapped.card.rarity).toBeNull();
    expect(mapped.warnings.some((w) => w.code === 'PRICE_VALUE')).toBe(true);
    expect(mapped.prices.find((p) => p.source === 'tcgplayer' && p.variant === 'normal')!.marketCents).toBeNull();
  });
  it('does not store a price row when the print has no number, and keeps a genuine zero', () => {
    const raw = structuredClone(fixture<RawCard>('en-card-swsh3-136.json')) as RawCard;
    const cm = (raw.variants_detailed![0] as { pricing: { cardmarket: Record<string, unknown> } }).pricing.cardmarket;
    cm.avg = 0;
    const mapped = mapCard(raw, en);
    expect(mapped.prices.find((p) => p.source === 'cardmarket' && p.variant === 'normal')!.midCents).toBe(0);
  });
});

describe('ambiguous shared cardmarket foil', () => {
  it('stores other + cardmarket_holo_unspecified instead of applying one foil quote to holo and reverse', () => {
    const block = { unit: 'EUR', updated: '2026-10-30T22:54:33.134Z', idProduct: 1, avg: 1, low: 0.5, trend: 1, 'avg-holo': 3, 'low-holo': 2, 'trend-holo': 3 };
    const raw = {
      id: 'x-1', localId: '1', name: 'Test', set: { id: 'x' }, variants: { holo: true, reverse: true },
      variants_detailed: [
        { type: 'holo', size: 'standard', thirdParty: { cardmarket: 1 }, pricing: { cardmarket: block } },
        { type: 'reverse', size: 'standard', thirdParty: { cardmarket: 1 }, pricing: { cardmarket: block } }
      ]
    } as unknown as RawCard;
    const mapped = mapCard(raw, en);
    expect(priceSummary(mapped)).toEqual(['cardmarket|other|cardmarket_holo_unspecified|1:avg-holo:cardmarket_holo_unspecified|200/300/null/null/300']);
  });
  it('uses root pricing only when exactly one detailed row exists', () => {
    const pricing = { cardmarket: { unit: 'EUR', idProduct: 7, avg: 2, low: 1, trend: 2 }, tcgplayer: null };
    const one = { id: 'x-2', localId: '2', name: 'One', set: { id: 'x' }, variants_detailed: [{ type: 'normal', size: 'standard' }], pricing } as unknown as RawCard;
    const two = { ...one, variants_detailed: [{ type: 'normal', size: 'standard' }, { type: 'reverse', size: 'standard' }] } as unknown as RawCard;
    expect(mapCard(one, en).prices).toHaveLength(1);
    expect(mapCard(two, en).prices).toHaveLength(0);
  });
});

describe('mapSet / set index', () => {
  it('maps a published set with the active manifest in raw_json and rewritten symbol', () => {
    const raw = fixture<RawSetDetail>('en-set-swsh3.json');
    const row = mapSet(raw, en);
    expect(row).toMatchObject({
      language: 'en', id: 'swsh3', name: 'Darkness Ablaze', series: 'swsh', status: 'published', releaseDate: '2020-08-14',
      officialCount: 189, totalCount: 201,
      logoUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/logo.webp', symbolUrl: 'https://assets.tcgdex.net/en/swsh/swsh3/symbol.webp'
    });
    expect(JSON.parse(row.rawJson).cards.length).toBe(raw.cards!.length);
    expect(raw.cards!.length).toBeGreaterThan(150);
  });
  it('marks an empty JA shell unpublished and stores cards: [] as the manifest', () => {
    const row = mapSet(fixture<RawSetDetail>('ja-set-ADV1-shell.json'), ja);
    expect(row).toMatchObject({ language: 'ja', id: 'ADV1', status: 'unpublished', logoUrl: null, symbolUrl: null, totalCount: 55, officialCount: 55 });
    expect(JSON.parse(row.rawJson).cards).toEqual([]);
  });
  it('builds the bootstrap index entry', () => {
    expect(mapSetIndexEntry(fixture<RawSetDetail>('ja-set-ADV1-shell.json'), ja)).toEqual({
      language: 'ja', id: 'ADV1', name: '拡張パック', series: 'ADV', releaseDate: '2003-01-31', totalCount: 55, officialCount: 55,
      logoUrl: null, symbolUrl: null, status: 'unpublished'
    });
  });
});
