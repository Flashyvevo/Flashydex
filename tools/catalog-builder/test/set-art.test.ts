import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawSetBrief, RawSetDetail } from '@flashydex/core/catalog/tcgdex';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCatalogDb } from '../src/build-db';
import { Fetcher } from '../src/http';
import { loadCatalogMigrations } from '../src/migrations';
import { alternateLogoCandidates, computeSetLogoCoverage, enTwinLogo, JA_TO_EN_LOGO, resolveSetArt, setAssetUrl } from '../src/set-art';

const dir = mkdtempSync(join(tmpdir(), 'fdx-setart-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const detail = (id: string, serie: string, extra: Partial<RawSetDetail> = {}): RawSetDetail => ({
  id, name: id, serie: { id: serie }, cards: [{ id: `${id}-1`, localId: '1', name: 'x' }], ...extra
});
const A = 'https://assets.tcgdex.net';

/** Fetcher whose HEAD answers 200 only for the listed URLs (everything else 404). */
function fetcherWith(live: string[], seen: string[] = []): Fetcher {
  return new Fetcher({
    sleep: async () => undefined,
    fetchImpl: (async (url: string) => {
      seen.push(url);
      return new Response('', { status: live.includes(url) ? 200 : 404 });
    }) as unknown as typeof fetch
  });
}

describe('set logo fallbacks', () => {
  it('builds standard asset URLs and orders candidates logo -> symbol', () => {
    expect(setAssetUrl('en', 'sv', 'sv05', 'logo.webp')).toBe(`${A}/en/sv/sv05/logo.webp`);
    const cands = alternateLogoCandidates('en', detail('sv05', 'sv', { symbol: `${A}/univ/sv/sv05/symbol` }));
    expect(cands.map((c) => `${c.source}:${c.url.replace(A, '')}`)).toEqual([
      'tcgdex:/en/sv/sv05/logo.webp', 'tcgdex:/en/sv/sv05/logo.png',
      'symbol:/en/sv/sv05/symbol.webp', 'symbol:/en/sv/sv05/symbol.png'
    ]);
  });

  it('keeps native logos untouched and never probes them', async () => {
    const seen: string[] = [];
    const art = await resolveSetArt({
      language: 'en', fetcher: fetcherWith([], seen), warnings: [], selectedSetIds: ['swsh3'],
      details: new Map([['swsh3', detail('swsh3', 'swsh', { logo: `${A}/en/swsh/swsh3/logo` })]])
    });
    expect(art.get('swsh3')).toEqual({ logoUrl: `${A}/en/swsh/swsh3/logo.webp`, source: 'tcgdex' });
    expect(seen).toEqual([]);
  });

  it('EN: probed alternate logo wins, then probed symbol, never an unprobed URL', async () => {
    const live = [`${A}/en/me/30th/logo.png`, `${A}/en/sv/sv05/symbol.webp`, `${A}/en/sv/sv05/symbol.png`];
    const art = await resolveSetArt({
      language: 'en', fetcher: fetcherWith(live), warnings: [], selectedSetIds: ['30th', 'sv05', 'mfb'],
      details: new Map([['30th', detail('30th', 'me')], ['sv05', detail('sv05', 'sv')], ['mfb', detail('mfb', 'sv')]])
    });
    expect(art.get('30th')).toEqual({ logoUrl: `${A}/en/me/30th/logo.png`, source: 'tcgdex' });
    expect(art.get('sv05')).toEqual({ logoUrl: `${A}/en/sv/sv05/symbol.webp`, source: 'symbol' });
    expect(art.has('mfb')).toBe(false);
  });

  it('JA: alternate logo > EN twin > symbol; twin needs a probed-200 EN logo and a table entry', async () => {
    const enBriefs: RawSetBrief[] = [
      { id: 'sv03', name: 'Obsidian Flames', logo: `${A}/en/sv/sv03/logo` },
      { id: 'sv05', name: 'Temporal Forces' }, // no EN logo -> twin unusable
      { id: 'sv04', name: 'Paradox Rift', logo: `${A}/en/sv/sv04/logo` } // EN logo 404s -> twin unusable
    ];
    const live = [`${A}/en/sv/sv03/logo.webp`, `${A}/ja/M/M4/logo.webp`, `${A}/ja/SV/SV5K/symbol.webp`];
    const warnings: string[] = [];
    const art = await resolveSetArt({
      language: 'ja', fetcher: fetcherWith(live), warnings, fetchEnBriefs: async () => enBriefs,
      selectedSetIds: ['M4', 'SV3', 'SV4K', 'SV5K', 'SV8a'],
      details: new Map([
        ['M4', detail('M4', 'M')], ['SV3', detail('SV3', 'SV')], ['SV4K', detail('SV4K', 'SV')],
        ['SV5K', detail('SV5K', 'SV')], ['SV8a', detail('SV8a', 'SV')]
      ])
    });
    expect(art.get('M4')).toEqual({ logoUrl: `${A}/ja/M/M4/logo.webp`, source: 'tcgdex' });
    expect(art.get('SV3')).toEqual({ logoUrl: `${A}/en/sv/sv03/logo.webp`, source: 'en-twin' });
    expect(art.has('SV4K')).toBe(false); // EN logo not live
    expect(art.get('SV5K')).toEqual({ logoUrl: `${A}/ja/SV/SV5K/symbol.webp`, source: 'symbol' }); // twin has no logo -> symbol
    expect(art.has('SV8a')).toBe(false); // JA-only product, not in table
    expect(warnings.join('\n')).toMatch(/EN set sv05 has no logo/);
  });

  it('JA_TO_EN_LOGO is small, one EN target per JA id, and targets only look like EN ids', () => {
    expect(Object.keys(JA_TO_EN_LOGO).length).toBeLessThan(120);
    for (const [ja, en] of Object.entries(JA_TO_EN_LOGO)) {
      expect(ja).not.toBe('');
      expect(en).toMatch(/^[a-z]+[0-9.]*[a-z]*$/);
    }
    expect(enTwinLogo('SV1S', new Map([['sv01', 'u']]))).toEqual({ logoUrl: 'u', source: 'en-twin' });
    expect(enTwinLogo('nope', new Map([['sv01', 'u']]))).toBeNull();
  });

  it('computes coverage by provenance', () => {
    expect(computeSetLogoCoverage([
      { logoUrl: 'a', symbolUrl: 's', logoSource: 'tcgdex' },
      { logoUrl: 'b', symbolUrl: null, logoSource: 'en-twin' },
      { logoUrl: 'c', symbolUrl: 's', logoSource: 'symbol' },
      { logoUrl: null, symbolUrl: null, logoSource: null }
    ])).toEqual({ sets: 4, withLogo: 3, withSymbol: 2, byProvenance: { tcgdex: 1, symbol: 1, 'en-twin': 1, none: 1 } });
  });

  it('buildCatalogDb writes the resolved logo, raw_json.logoSource and coverage', () => {
    const details = new Map([
      ['a', detail('a', 'sv', { logo: `${A}/en/sv/a/logo` })],
      ['b', detail('b', 'sv')],
      ['c', detail('c', 'sv')]
    ]);
    const path = join(dir, 'x.db.part');
    const result = buildCatalogDb(path, {
      language: 'en', version: '2026.11.07.001', builtAt: '2026-11-07T00:00:00.000Z', cutoffAt: '2026-11-07T00:00:00.000Z', builderVersion: 't',
      details, selectedSetIds: ['a', 'b', 'c'], cards: new Map(), missingAssets: new Set(), migrations: loadCatalogMigrations(),
      setArt: new Map([
        ['a', { logoUrl: `${A}/en/sv/a/logo.webp`, source: 'tcgdex' as const }],
        ['b', { logoUrl: `${A}/en/sv/b/symbol.webp`, source: 'symbol' as const }]
      ])
    });
    expect(result.setLogoCoverage.byProvenance).toEqual({ tcgdex: 1, symbol: 1, 'en-twin': 0, none: 1 });
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT id, logo_url, raw_json FROM catalog_sets ORDER BY id').all() as Array<{ id: string; logo_url: string | null; raw_json: string }>;
    db.close();
    expect(rows.map((r) => [r.id, r.logo_url, JSON.parse(r.raw_json).logoSource])).toEqual([
      ['a', `${A}/en/sv/a/logo.webp`, 'tcgdex'], ['b', `${A}/en/sv/b/symbol.webp`, 'symbol'], ['c', null, null]
    ]);
  });
});
