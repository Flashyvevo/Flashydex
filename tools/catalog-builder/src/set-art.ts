import { logoUrl, symbolUrl, type CatalogLanguage, type RawSetBrief, type RawSetDetail } from '@flashydex/core/catalog/tcgdex';
import { TCGDEX_API } from './crawl';
import { pool, type Fetcher } from './http';

/** Where a pack's `catalog_sets.logo_url` came from. Stored in `raw_json.logoSource`. */
export type LogoSource = 'tcgdex' | 'symbol' | 'en-twin';

export interface SetArt { logoUrl: string; source: LogoSource }

const ASSET_BASE = 'https://assets.tcgdex.net';

/** Alternate logo files TCGdex hosts even when the set JSON omits `logo` (tried in order, each only after an HTTP 200). */
const LOGO_FILES = ['logo.webp', 'logo.png'] as const;
/** Logo-of-last-resort: the set symbol, same probe rule. */
const SYMBOL_FILES = ['symbol.webp', 'symbol.png'] as const;

/**
 * JA set id -> EN set id for sets that are the same product line (same name, same release wave). Used ONLY to borrow the
 * EN logo for JA sets TCGdex ships no logo for (it ships none for any JA set at all). Auditable by eye: left = JA code,
 * right = EN id. Counts/dates cannot be used to auto-match (JA and EN splits differ: SV1S+SV1V -> sv01, official counts
 * collide across eras), so this stays a hand-written table. An entry is ignored when the EN set has no probed-200 logo.
 * Deliberately omitted: JA-only products with no EN equivalent (Triplet Beat, VMAX Rising, Terastal Fest ex, ...),
 * promos, and the e-card/PCG/ADV eras.
 */
export const JA_TO_EN_LOGO: Readonly<Record<string, string>> = {
  // Scarlet & Violet
  SV1S: 'sv01', SV1V: 'sv01', SV2D: 'sv02', SV2P: 'sv02', SV3: 'sv03', SV2a: 'sv03.5', SV4K: 'sv04', SV4M: 'sv04',
  SV4a: 'sv04.5', SV5K: 'sv05', SV5M: 'sv05', SV6: 'sv06', SV6a: 'sv06.5', SV7: 'sv07', SV8: 'sv08', SV9: 'sv09',
  SV10: 'sv10', SV11B: 'sv10.5b', SV11W: 'sv10.5w',
  // Mega Evolution
  M1L: 'me01', M1S: 'me01', M2: 'me02', M2a: 'me02.5', M3: 'me03', M4: 'me04', M5: 'me05',
  // Sword & Shield
  S1H: 'swsh1', S1W: 'swsh1', S2: 'swsh2', S4: 'swsh4', S4a: 'swsh4.5', S5I: 'swsh5', S5R: 'swsh5', S6H: 'swsh6', S6K: 'swsh6',
  S7D: 'swsh7', S7R: 'swsh7', S8: 'swsh8', S8a: 'cel25', S9: 'swsh9', S10D: 'swsh10', S10P: 'swsh10', S10b: 'swsh10.5',
  S11: 'swsh11', S12: 'swsh12', S12a: 'swsh12.5',
  // Sun & Moon
  SM1S: 'sm1', SM1M: 'sm1', SM2K: 'sm2', SM2L: 'sm2', SM3H: 'sm3', SM3N: 'sm3', SM4A: 'sm4', SM4S: 'sm4', SM5S: 'sm5', SM5M: 'sm5',
  SM6: 'sm6', SM7: 'sm7', SM8: 'sm8', SM9: 'sm9', SM10: 'sm10', SM11: 'sm11', SM12: 'sm12', SMP2: 'det1',
  // XY
  XY2: 'xy2', XY3: 'xy3', XY4: 'xy4', XY5a: 'xy5', XY5b: 'xy5', XY6: 'xy6', XY7: 'xy7', XY8a: 'xy8', XY8b: 'xy8', XY9: 'xy9',
  XY10: 'xy10', XY11a: 'xy11', XY11b: 'xy11', CP1: 'dc1', CP6: 'xy12'
};

/** Standard TCGdex asset path for a set file: `{base}/{lang}/{serie}/{setId}/{file}` (ids are path-encoded like the API). */
export function setAssetUrl(language: CatalogLanguage, serieId: string, setId: string, file: string): string {
  return `${ASSET_BASE}/${language}/${encodeURIComponent(serieId)}/${encodeURIComponent(setId)}/${file}`;
}

/** URLs to probe for a set with no `logo`, in preference order: logo files, then the set symbol (JSON one first, then files). */
export function alternateLogoCandidates(language: CatalogLanguage, detail: RawSetDetail): Array<{ url: string; source: LogoSource }> {
  const serie = detail.serie?.id;
  const out: Array<{ url: string; source: LogoSource }> = [];
  const push = (url: string | null, source: LogoSource) => { if (url && !out.some((c) => c.url === url)) out.push({ url, source }); };
  if (serie) for (const file of LOGO_FILES) push(setAssetUrl(language, serie, detail.id, file), 'tcgdex');
  push(symbolUrl(detail.symbol, language), 'symbol');
  if (serie) for (const file of SYMBOL_FILES) push(setAssetUrl(language, serie, detail.id, file), 'symbol');
  return out;
}

/** Pure choice of the first candidate whose URL is in `ok` (the set of URLs that answered HTTP 200). */
export function pickFirstProbed(candidates: ReadonlyArray<{ url: string; source: LogoSource }>, ok: ReadonlySet<string>): SetArt | null {
  const hit = candidates.find((c) => ok.has(c.url));
  return hit ? { logoUrl: hit.url, source: hit.source } : null;
}

/** EN-twin lookup. `enLogos` = EN set id -> logo URL that is known-good (native JSON logo or probed 200). */
export function enTwinLogo(jaSetId: string, enLogos: ReadonlyMap<string, string>, table: Readonly<Record<string, string>> = JA_TO_EN_LOGO): SetArt | null {
  const twin = table[jaSetId];
  if (!twin) return null;
  const url = enLogos.get(twin);
  return url ? { logoUrl: url, source: 'en-twin' } : null;
}

/** HEAD-probe URLs; only an exact HTTP 200 counts as present. Network errors count as absent (never fabricate). */
export async function probeOk(fetcher: Fetcher, urls: readonly string[], warnings: string[]): Promise<Set<string>> {
  const ok = new Set<string>();
  await pool([...new Set(urls)], 16, async (url) => {
    try {
      if ((await fetcher.headStatus(url)) === 200) ok.add(url);
    } catch (error) {
      warnings.push(`logo probe failed for ${url}: ${error instanceof Error ? error.message : String(error)} (treated as absent)`);
    }
  });
  return ok;
}

export interface ResolveSetArtInput {
  language: CatalogLanguage;
  details: ReadonlyMap<string, RawSetDetail>;
  selectedSetIds: readonly string[];
  fetcher: Fetcher;
  warnings: string[];
  /** Fetch the EN set list (for JA twin logos). Injected for tests. */
  fetchEnBriefs?: () => Promise<RawSetBrief[]>;
  table?: Readonly<Record<string, string>>;
}

/**
 * For every selected set: native TCGdex logo -> 'tcgdex'; else a probed alternate logo file -> 'tcgdex'; else (JA) the EN twin's
 * logo -> 'en-twin'; else a probed symbol -> 'symbol'. Sets with nothing stay absent (the app falls back to a cover card).
 * Native logos are trusted exactly as before (no probe), so the existing pack content is unchanged.
 */
export async function resolveSetArt(input: ResolveSetArtInput): Promise<Map<string, SetArt>> {
  const { language, details, selectedSetIds, fetcher, warnings } = input;
  const result = new Map<string, SetArt>();
  const missing: RawSetDetail[] = [];
  for (const id of selectedSetIds) {
    const detail = details.get(id)!;
    const native = logoUrl(detail.logo);
    if (native) result.set(id, { logoUrl: native, source: 'tcgdex' });
    else missing.push(detail);
  }
  if (missing.length === 0) return result;

  const candidates = new Map(missing.map((d) => [d.id, alternateLogoCandidates(language, d)]));
  const probeUrls = [...candidates.values()].flat().map((c) => c.url);

  const table = input.table ?? JA_TO_EN_LOGO;
  const enLogos = new Map<string, string>();
  const twinIds = language === 'ja' ? [...new Set(missing.map((d) => table[d.id]).filter((v): v is string => !!v))] : [];
  if (twinIds.length > 0) {
    const briefs = await (input.fetchEnBriefs ?? (async () => fetcher.getJson<RawSetBrief[]>(`${TCGDEX_API}/en/sets`)))();
    const unprobed: Array<[string, string]> = [];
    for (const id of twinIds) {
      const brief = briefs.find((b) => b.id === id);
      const url = brief ? logoUrl(brief.logo) : null;
      if (!brief) warnings.push(`en-twin: ${id} not in the EN set list`);
      else if (url) unprobed.push([id, url]);
      else warnings.push(`en-twin: EN set ${id} has no logo`);
    }
    const okTwin = await probeOk(fetcher, unprobed.map(([, url]) => url), warnings);
    for (const [id, url] of unprobed) if (okTwin.has(url)) enLogos.set(id, url);
  }

  const ok = await probeOk(fetcher, probeUrls, warnings);
  for (const detail of missing) {
    const cands = candidates.get(detail.id)!;
    const logoHit = pickFirstProbed(cands.filter((c) => c.source === 'tcgdex'), ok);
    const art = logoHit ?? (language === 'ja' ? enTwinLogo(detail.id, enLogos, table) : null) ?? pickFirstProbed(cands.filter((c) => c.source === 'symbol'), ok);
    if (art) result.set(detail.id, art);
  }
  return result;
}

export interface SetLogoCoverage {
  sets: number;
  withLogo: number;
  withSymbol: number;
  byProvenance: { tcgdex: number; symbol: number; 'en-twin': number; none: number };
}

export function computeSetLogoCoverage(rows: ReadonlyArray<{ logoUrl: string | null; symbolUrl: string | null; logoSource: LogoSource | null }>): SetLogoCoverage {
  const byProvenance = { tcgdex: 0, symbol: 0, 'en-twin': 0, none: 0 };
  for (const row of rows) byProvenance[row.logoUrl && row.logoSource ? row.logoSource : 'none'] += 1;
  return {
    sets: rows.length,
    withLogo: rows.filter((r) => r.logoUrl).length,
    withSymbol: rows.filter((r) => r.symbolUrl).length,
    byProvenance
  };
}
