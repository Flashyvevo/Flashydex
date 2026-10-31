import { join } from 'node:path';
import { encodeIdForPath, type CatalogLanguage, type RawCard, type RawSetBrief, type RawSetDetail } from '@flashydex/core/catalog/tcgdex';
import { Fetcher, HttpError, pool } from './http';

export const TCGDEX_API = process.env.TCGDEX_API ?? 'https://api.tcgdex.net/v2';

export interface CrawlResult {
  /** `/v2/{lang}/sets` list, in provider order. */
  list: RawSetBrief[];
  /** Set DETAIL for EVERY set in the list (needed for the bootstrap index: status/series/releaseDate). */
  details: Map<string, RawSetDetail>;
  /** Selected set ids (all sets, or the `--sets` subset), sorted. */
  selectedSetIds: string[];
  /** Full card detail for every card in each selected set's manifest. */
  cards: Map<string, RawCard>;
  failures: Array<{ unit: string; error: string }>;
  warnings: string[];
}

export interface CrawlOptions {
  language: CatalogLanguage;
  sets?: readonly string[];
  cacheRoot: string;
  log: (message: string) => void;
}

/**
 * Crawl TCGdex for one language. Ids are `encodeURIComponent`-ed exactly once (`SM1+` -> `SM1%2B`); a provider id that
 * already contains `%3F` (EN `exu`) is encoded again on purpose, never decoded. Every response is cached on disk
 * (`.cache/<lang>/...`) so reruns and resumes do not refetch.
 */
export async function crawl(fetcher: Fetcher, options: CrawlOptions): Promise<CrawlResult> {
  const { language, cacheRoot, log } = options;
  const langRoot = join(cacheRoot, language);
  const failures: CrawlResult['failures'] = [];
  const warnings: string[] = [];

  const list = await fetcher.getJson<RawSetBrief[]>(`${TCGDEX_API}/${language}/sets`, join(langRoot, 'sets.json'));
  if (!Array.isArray(list) || list.length === 0) throw new Error(`TCGdex returned no sets for ${language}`);
  const ids = list.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate set ids in /v2/${language}/sets`);
  log(`${language}: ${list.length} sets in provider list`);

  const detailList = await pool(list, 16, async (brief): Promise<[string, RawSetDetail | null]> => {
    try {
      const detail = await fetcher.getJson<RawSetDetail>(
        `${TCGDEX_API}/${language}/sets/${encodeIdForPath(brief.id)}`, join(langRoot, 'sets', `${encodeIdForPath(brief.id)}.json`)
      );
      if (detail.id !== brief.id) throw new Error(`set detail id ${detail.id} != list id ${brief.id}`);
      return [brief.id, detail];
    } catch (error) {
      failures.push({ unit: `set ${brief.id}`, error: error instanceof Error ? error.message : String(error) });
      return [brief.id, null];
    }
  });
  const details = new Map<string, RawSetDetail>();
  for (const [id, detail] of detailList) if (detail) details.set(id, detail);

  let selectedSetIds = [...ids];
  if (options.sets?.length) {
    const unknown = options.sets.filter((id) => !details.has(id));
    if (unknown.length) throw new Error(`Requested set(s) not found in ${language}: ${unknown.join(', ')}`);
    selectedSetIds = [...new Set(options.sets)];
  }
  selectedSetIds = selectedSetIds.filter((id) => details.has(id)).sort();

  const briefs: Array<{ setId: string; cardId: string }> = [];
  for (const setId of selectedSetIds) {
    const detail = details.get(setId)!;
    const cards = Array.isArray(detail.cards) ? detail.cards : [];
    const advertised = detail.cardCount?.total;
    if (cards.length === 0) warnings.push(`set ${setId}: empty shell (advertises ${advertised ?? '?'} cards) -> unpublished`);
    else if (typeof advertised === 'number' && advertised !== cards.length) warnings.push(`set ${setId}: advertised total ${advertised} != ${cards.length} cards in manifest (trusting the array)`);
    for (const card of cards) briefs.push({ setId, cardId: card.id });
  }
  const seen = new Set<string>();
  for (const { cardId } of briefs) {
    if (seen.has(cardId)) throw new Error(`Duplicate card id ${cardId} in ${language} set manifests`);
    seen.add(cardId);
  }
  log(`${language}: ${selectedSetIds.length} selected sets, ${briefs.length} card details to load`);

  const cards = new Map<string, RawCard>();
  let done = 0;
  const started = Date.now();
  await pool(briefs, 32, async ({ setId, cardId }) => {
    try {
      const card = await fetcher.getJson<RawCard>(
        `${TCGDEX_API}/${language}/cards/${encodeIdForPath(cardId)}`, join(langRoot, 'cards', `${encodeIdForPath(cardId)}.json`)
      );
      if (card.id !== cardId) throw new Error(`card detail id ${card.id} != requested ${cardId}`);
      if (card.set?.id !== setId) throw new Error(`card ${cardId} belongs to set ${card.set?.id}, expected ${setId}`);
      if (card.localId === undefined || card.localId === null || typeof card.name !== 'string') throw new Error(`card ${cardId} lacks localId/name`);
      cards.set(cardId, card);
    } catch (error) {
      const message = error instanceof HttpError ? `HTTP ${error.status}` : error instanceof Error ? error.message : String(error);
      failures.push({ unit: `card ${cardId}`, error: message });
    }
    done += 1;
    if (done % 500 === 0) log(`${language}: ${done}/${briefs.length} cards (${Math.round((Date.now() - started) / 1000)} s, concurrency ${fetcher.currentConcurrency})`);
  });

  return { list, details, selectedSetIds, cards, failures, warnings };
}

/** HEAD-check symbol URLs; only a definite 404 nulls the URL (research: univ symbols can 404). */
export async function checkAssetUrls(fetcher: Fetcher, urls: readonly string[], warnings: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  await pool([...new Set(urls)], 16, async (url) => {
    try {
      const status = await fetcher.headStatus(url);
      if (status === 404) missing.add(url);
    } catch (error) {
      warnings.push(`asset check failed for ${url}: ${error instanceof Error ? error.message : String(error)} (URL kept)`);
    }
  });
  return missing;
}
