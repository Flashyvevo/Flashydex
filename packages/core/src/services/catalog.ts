import {
  CardDetailQuery, CardSearchQuery, SetCardsQuery, SetKey, SetListQuery, type CardDetail, type CardSummary, type Input, type OwnedDto, type Page, type SetSummary
} from '@flashydex/schemas';
import { nameSearch } from '../catalog/tcgdex';
import { chunk, placeholders, type Db } from '../db/sql';
import { latestPerKey, type Quote } from '../domain/valuation';
import { NotFoundError } from '../errors';
import { CHUNK, identityKey, loadQuotes, manifestIds, parse, parseJson, prefixUpperBound, readSettings, type ServiceContext } from './context';
import { hydrateOwned } from './owned-read';

type Language = 'en' | 'ja';
/** E2: the catalog handle generations a read must be protected against (all languages when none is named). */
const languagesOf = (language: Language | undefined): Language[] => (language ? [language] : ['en', 'ja']);
const VARIANT_ORDER = ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other'] as const;

type SetRow = {
  id: string; name: string; series: string | null; status: 'published' | 'unpublished'; releaseDate: string | null; officialCount: number | null;
  totalCount: number | null; logoUrl: string | null; symbolUrl: string | null; rawJson: string;
};
const SET_COLS = {
  id: 'id', name: 'name', series: 'series', status: 'status', releaseDate: 'release_date', officialCount: 'official_count', totalCount: 'total_count',
  logoUrl: 'logo_url', symbolUrl: 'symbol_url', rawJson: 'raw_json'
} as const;

type CardRow = {
  id: string; language: Language; name: string; setId: string; setName: string | null; localId: string; rarity: string | null; imageUrl: string | null;
  variants: string; detailSyncedAt: string | null; category: string | null; illustrator: string | null; syncedAt: string; nameSearch: string; setOfficialCount: number | null;
};
const CARD_COLS = {
  id: 'c.id', language: 'c.language', name: 'c.name', setId: 'c.set_id', setName: 's.name', localId: 'c.local_id', rarity: 'c.rarity',
  imageUrl: 'c.image_url', variants: 'c.available_variants_json', detailSyncedAt: 'c.detail_synced_at', category: 'c.category',
  illustrator: 'c.illustrator', syncedAt: 'c.synced_at', nameSearch: 'c.name_search', setOfficialCount: 's.official_count'
} as const;
const CARD_FROM = 'FROM catalog_cards c LEFT JOIN catalog_sets s ON s.language = c.language AND s.id = c.set_id';

const variantsOf = (json: string): CardSummary['availableVariants'] => {
  const set = new Set(parseJson<string[]>(json, []));
  return VARIANT_ORDER.filter((v) => set.has(v));
};

const toSummary = (r: CardRow, ownedCount: number): CardSummary => ({
  id: r.id, language: r.language, name: r.name, setId: r.setId, setName: r.setName, localId: r.localId, rarity: r.rarity, imageUrl: r.imageUrl,
  availableVariants: variantsOf(r.variants), detailsComplete: r.detailSyncedAt !== null, ownedCount,
  setOfficialCount: r.setOfficialCount === null || r.setOfficialCount === undefined ? null : Number(r.setOfficialCount)
});

const page = <T>(data: T[], offset: number, limit: number, total: number): Page<T> => ({ data, page: { offset, limit, total, hasMore: offset + data.length < total } });

type OwnedByIdentity = { count: Map<string, number>; groups: Map<string, number> };

export class CatalogRepo {
  constructor(private readonly ctx: ServiceContext) {}

  private async catalogs(language?: Language): Promise<Array<{ language: Language; db: Db }>> {
    const languages: Language[] = language ? [language] : ['en', 'ja'];
    const out: Array<{ language: Language; db: Db }> = [];
    for (const l of languages) {
      const db = await this.ctx.databases.catalog(l);
      if (db) out.push({ language: l, db });
    }
    return out;
  }

  /** Owned copy counts per catalog identity (and per precise group) for one language, optionally narrowed to ids. */
  private async ownedByIdentity(language: Language, ids?: readonly string[]): Promise<OwnedByIdentity> {
    const count = new Map<string, number>();
    const groups = new Map<string, number>();
    const add = (rows: unknown[][]) => {
      for (const r of rows) {
        const id = String(r[0]);
        const n = Number(r[3]);
        count.set(id, (count.get(id) ?? 0) + n);
        groups.set(`${id}\u0000${String(r[1])}\u0000${String(r[2])}`, n);
      }
    };
    const sql = 'SELECT catalog_card_id, variant, variant_detail, COUNT(*) FROM owned_cards WHERE language = ? AND catalog_card_id IS NOT NULL';
    if (ids) {
      for (const part of chunk([...new Set(ids)], CHUNK)) {
        add(await this.ctx.databases.user.rows(`${sql} AND catalog_card_id IN (${placeholders(part.length)}) GROUP BY catalog_card_id, variant, variant_detail`, [language, ...part]));
      }
    } else {
      add(await this.ctx.databases.user.rows(`${sql} GROUP BY catalog_card_id, variant, variant_detail`, [language]));
    }
    return { count, groups };
  }

  /* ----------------------------------------------------------------------------------------------- sets */
  private async computeSets(
    language: Language, db: Db, where: string, params: unknown[], exact: (id: string) => boolean
  ): Promise<SetSummary[]> {
    const sets = await db.select<SetRow>(SET_COLS, `FROM catalog_sets ${where}`, params);
    const cachedCounts = new Map<string, number>();
    for (const r of await db.rows('SELECT set_id, COUNT(*) FROM catalog_cards WHERE language = ? GROUP BY set_id', [language])) cachedCounts.set(String(r[0]), Number(r[1]));

    // Owned stats for this language, bucketed by snapshot set id.
    const user = this.ctx.databases.user;
    const ownedRows = await user.rows(
      'SELECT set_id, catalog_card_id, variant, variant_detail, COUNT(*) FROM owned_cards WHERE language = ? AND catalog_card_id IS NOT NULL AND set_id IS NOT NULL GROUP BY set_id, catalog_card_id, variant, variant_detail',
      [language]
    );
    const customRows = await user.rows('SELECT set_id, COUNT(*) FROM owned_cards WHERE language = ? AND custom_card_id IS NOT NULL AND set_id IS NOT NULL GROUP BY set_id', [language]);
    const customBySet = new Map(customRows.map((r) => [String(r[0]), Number(r[1])]));
    const bySet = new Map<string, { copies: number; extras: number; ids: Set<string> }>();
    for (const r of ownedRows) {
      const entry = bySet.get(String(r[0])) ?? { copies: 0, extras: 0, ids: new Set<string>() };
      const n = Number(r[4]);
      entry.copies += n;
      entry.extras += Math.max(n - 1, 0);
      entry.ids.add(String(r[1]));
      bySet.set(String(r[0]), entry);
    }

    const out: SetSummary[] = [];
    for (const s of sets) {
      const manifest = manifestIds(s.rawJson);
      const owned = bySet.get(s.id);
      let catalogCount: number;
      let catalogComplete: boolean;
      let ownedUnique = 0;
      if (exact(s.id)) {
        const cached = new Set((await db.rows('SELECT id FROM catalog_cards WHERE language = ? AND set_id = ?', [language, s.id])).map((r) => String(r[0])));
        const present = manifest.filter((id) => cached.has(id));
        catalogCount = present.length;
        catalogComplete = s.status === 'published' && manifest.length > 0 && present.length === manifest.length;
        if (owned) ownedUnique = present.filter((id) => owned.ids.has(id)).length;
      } else {
        // Cheap path for sets that are neither displayed nor owned: counts only (null-vs-zero completion ordering).
        const cached = cachedCounts.get(s.id) ?? 0;
        catalogCount = Math.min(cached, manifest.length);
        catalogComplete = s.status === 'published' && manifest.length > 0 && cached >= manifest.length;
      }
      const completion = catalogComplete && catalogCount > 0 ? Math.round((100 * ownedUnique) / catalogCount * 100) / 100 : null;
      out.push({
        id: s.id, language, name: s.name, series: s.series, status: s.status, releaseDate: s.releaseDate, logoUrl: s.logoUrl, symbolUrl: s.symbolUrl,
        officialCount: s.officialCount === null ? null : Number(s.officialCount), totalCount: s.totalCount === null ? null : Number(s.totalCount),
        catalogCount, catalogComplete, ownedCount: owned?.copies ?? 0, customOwnedCount: customBySet.get(s.id) ?? 0, ownedUnique,
        missingCount: Math.max(catalogCount - ownedUnique, 0), duplicateExtras: owned?.extras ?? 0, completionPercent: completion
      });
    }
    return out;
  }

  async listSets(input: Input<typeof SetListQuery>): Promise<Page<SetSummary>> {
    return this.ctx.databases.consistentRead(languagesOf(parse(SetListQuery, input).language), () => this.listSetsOnce(input));
  }

  private async listSetsOnce(input: Input<typeof SetListQuery>): Promise<Page<SetSummary>> {
    const q = parse(SetListQuery, input);
    const settings = await this.ctx.databases.user.read((r) => readSettings(r));
    const hidePocket = q.hideTcgPocket ?? settings.hideTcgPocket;
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status !== 'all') { where.push('status = ?'); params.push(q.status); }
    if (q.q) { where.push('instr(name_search, ?) > 0'); params.push(nameSearch(q.q)); }
    if (hidePocket) where.push("(series IS NULL OR series <> 'tcgp')");
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const all: SetSummary[] = [];
    for (const { language, db } of await this.catalogs(q.language)) {
      // Sets with owned copies get exact completion; the rest use the cheap count path unless they land on the returned page.
      const ownedSetIds = new Set((await this.ctx.databases.user.rows('SELECT DISTINCT set_id FROM owned_cards WHERE language = ? AND set_id IS NOT NULL', [language])).map((r) => String(r[0])));
      all.push(...(await this.computeSets(language, db, clause, params, (id) => ownedSetIds.has(id))));
    }

    let rows = all;
    if (q.owned === true) rows = rows.filter((s) => s.ownedCount > 0);
    if (q.owned === false) rows = rows.filter((s) => s.ownedCount === 0);
    const cmpDate = (a: SetSummary, b: SetSummary): number => {
      if (a.releaseDate === b.releaseDate) return 0;
      if (a.releaseDate === null) return 1;
      if (b.releaseDate === null) return -1;
      return a.releaseDate < b.releaseDate ? 1 : -1;
    };
    const tie = (a: SetSummary, b: SetSummary): number => a.language.localeCompare(b.language) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    rows.sort((a, b) => {
      let c = 0;
      if (q.sort === 'name_asc') { const an = nameSearch(a.name); const bn = nameSearch(b.name); c = an < bn ? -1 : an > bn ? 1 : 0; }
      else if (q.sort === 'completion_desc') {
        if (a.completionPercent === null && b.completionPercent === null) c = 0;
        else if (a.completionPercent === null) c = 1;
        else if (b.completionPercent === null) c = -1;
        else c = b.completionPercent - a.completionPercent;
      } else c = cmpDate(a, b);
      return c !== 0 ? c : tie(a, b);
    });
    const total = rows.length;
    const slice = rows.slice(q.offset, q.offset + q.limit);
    // Exact manifest reconciliation for the sets actually returned (the cheap path above only orders/filter-classifies).
    const exactSlice: SetSummary[] = [];
    for (const s of slice) {
      const db = await this.ctx.databases.catalog(s.language);
      const [exactRow] = db ? await this.computeSets(s.language, db, 'WHERE id = ?', [s.id], () => true) : [];
      exactSlice.push(exactRow ?? s);
    }
    return page(exactSlice, q.offset, q.limit, total);
  }

  async getSet(input: Input<typeof SetKey>): Promise<SetSummary & { missingPreview: CardSummary[] }> {
    return this.ctx.databases.consistentRead([parse(SetKey, input).language], () => this.getSetOnce(input));
  }

  private async getSetOnce(input: Input<typeof SetKey>): Promise<SetSummary & { missingPreview: CardSummary[] }> {
    const key = parse(SetKey, input);
    const db = await this.ctx.databases.catalog(key.language);
    if (!db) throw new NotFoundError('CatalogSet', key.setId, `The ${key.language} catalog is not installed`);
    const [summary] = await this.computeSets(key.language, db, 'WHERE id = ?', [key.setId], () => true);
    if (!summary) throw new NotFoundError('CatalogSet', key.setId);
    const missing = await this.setCards(key.language, db, key.setId, 'missing');
    const preview = missing.slice(0, 20);
    const owned = await this.ownedByIdentity(key.language, preview.map((c) => c.id));
    return { ...summary, missingPreview: preview.map((r) => toSummary(r, owned.count.get(r.id) ?? 0)) };
  }

  /**
   * Read-only cover-card lookup for set tiles: the image base of each set's first card (collector order) that has an image.
   * One statement per CHUNK sets; each set is a correlated LIMIT 1 over `cc_set_sort`, so cost is O(sets), not O(cards).
   * Sets without a cached image map to null. Unknown ids are simply absent from the catalog and map to null.
   */
  async setCovers(language: Language, setIds: readonly string[]): Promise<Record<string, string | null>> {
    return this.ctx.databases.consistentRead([language], async () => {
      const out: Record<string, string | null> = Object.fromEntries(setIds.map((id) => [id, null]));
      const db = await this.ctx.databases.catalog(language);
      if (!db) return out;
      for (const ids of chunk([...new Set(setIds)], CHUNK)) {
        const rows = await db.rows(
          `SELECT s.id, (SELECT c.image_url FROM catalog_cards c WHERE c.language = s.language AND c.set_id = s.id AND c.image_url IS NOT NULL ORDER BY c.local_id_sort ASC, c.id ASC LIMIT 1)
           FROM catalog_sets s WHERE s.language = ? AND s.id IN (${placeholders(ids.length)})`,
          [language, ...ids]
        );
        for (const r of rows) out[String(r[0])] = r[1] === null || r[1] === undefined ? null : String(r[1]);
      }
      return out;
    });
  }

  /** Cached cards that belong to the ACTIVE manifest of the set, local id order. */
  private async setCards(language: Language, db: Db, setId: string, ownership: 'all' | 'owned' | 'missing', duplicates?: boolean): Promise<CardRow[]> {
    const setRows = await db.select<{ raw: string }>({ raw: 'raw_json' }, 'FROM catalog_sets WHERE language = ? AND id = ?', [language, setId]);
    if (!setRows[0]) throw new NotFoundError('CatalogSet', setId);
    const manifest = new Set(manifestIds(setRows[0].raw));
    const cards = (await db.select<CardRow>(CARD_COLS, `${CARD_FROM} WHERE c.language = ? AND c.set_id = ? ORDER BY c.local_id_sort ASC, c.id ASC`, [language, setId])).filter((c) => manifest.has(c.id));
    if (ownership === 'all' && duplicates === undefined) return cards;
    const owned = await this.ownedByIdentity(language, cards.map((c) => c.id));
    return cards.filter((c) => {
      const isOwned = (owned.count.get(c.id) ?? 0) > 0;
      if (ownership === 'owned' && !isOwned) return false;
      if (ownership === 'missing' && isOwned) return false;
      if (duplicates !== undefined) {
        const hasDup = [...owned.groups.entries()].some(([k, n]) => k.startsWith(`${c.id}\u0000`) && n > 1);
        if (hasDup !== duplicates) return false;
      }
      return true;
    });
  }

  async listSetCards(input: Input<typeof SetCardsQuery>): Promise<Page<CardSummary>> {
    return this.ctx.databases.consistentRead([parse(SetCardsQuery, input).language], () => this.listSetCardsOnce(input));
  }

  private async listSetCardsOnce(input: Input<typeof SetCardsQuery>): Promise<Page<CardSummary>> {
    const q = parse(SetCardsQuery, input);
    const db = await this.ctx.databases.catalog(q.language);
    if (!db) throw new NotFoundError('CatalogSet', q.setId, `The ${q.language} catalog is not installed`);
    const cards = await this.setCards(q.language, db, q.setId, q.ownership, q.duplicates);
    const slice = cards.slice(q.offset, q.offset + q.limit);
    const owned = await this.ownedByIdentity(q.language, slice.map((c) => c.id));
    return page(slice.map((c) => toSummary(c, owned.count.get(c.id) ?? 0)), q.offset, q.limit, cards.length);
  }

  /* ----------------------------------------------------------------------------------------------- cards */
  async searchCards(input: Input<typeof CardSearchQuery>): Promise<Page<CardSummary>> {
    return this.ctx.databases.consistentRead(languagesOf(parse(CardSearchQuery, input).language), () => this.searchCardsOnce(input));
  }

  private async searchCardsOnce(input: Input<typeof CardSearchQuery>): Promise<Page<CardSummary>> {
    const q = parse(CardSearchQuery, input);
    const settings = await this.ctx.databases.user.read((r) => readSettings(r));
    const hidePocket = q.hideTcgPocket ?? settings.hideTcgPocket;
    const needle = q.q ? nameSearch(q.q) : '';
    const want = q.offset + q.limit;
    const streams: Array<{ rows: Array<CardRow & { rank: number }>; total: number }> = [];

    for (const { language, db } of await this.catalogs(q.language)) {
      const where: string[] = ['c.language = ?'];
      const params: unknown[] = [language];
      let rankSql = '0';
      const rankParams: unknown[] = [];
      if (needle) {
        if (q.match === 'prefix') {
          where.push('c.name_search >= ? AND c.name_search < ?');
          params.push(needle, prefixUpperBound(needle));
        } else {
          where.push('instr(c.name_search, ?) > 0');
          params.push(needle);
        }
        rankSql = 'CASE WHEN c.name_search = ? THEN 0 WHEN c.name_search >= ? AND c.name_search < ? THEN 1 ELSE 2 END';
        rankParams.push(needle, needle, prefixUpperBound(needle));
      }
      if (q.setId !== undefined) { where.push('c.set_id = ?'); params.push(q.setId); }
      if (q.localId !== undefined) { where.push('c.local_id = ?'); params.push(q.localId); }
      if (q.rarity !== undefined) { where.push('c.rarity = ?'); params.push(q.rarity); }
      if (hidePocket) where.push("(s.series IS NULL OR s.series <> 'tcgp')");
      const clause = where.join(' AND ');
      const total = Number(await db.scalar<number>(`SELECT COUNT(*) ${CARD_FROM} WHERE ${clause}`, params));
      const rows = await db.select<CardRow & { rank: number }>(
        { ...CARD_COLS, rank: rankSql }, `${CARD_FROM} WHERE ${clause} ORDER BY rank ASC, c.name_search ASC, c.language ASC, c.id ASC LIMIT ?`, [...rankParams, ...params, want]
      );
      streams.push({ rows, total });
    }

    const merged = streams.flatMap((s) => s.rows).sort((a, b) =>
      Number(a.rank) - Number(b.rank) || (a.nameSearch < b.nameSearch ? -1 : a.nameSearch > b.nameSearch ? 1 : 0) || a.language.localeCompare(b.language) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const total = streams.reduce((n, s) => n + s.total, 0);
    const slice = merged.slice(q.offset, q.offset + q.limit);
    const counts = new Map<string, number>();
    for (const language of ['en', 'ja'] as const) {
      const ids = slice.filter((c) => c.language === language).map((c) => c.id);
      if (ids.length === 0) continue;
      const owned = await this.ownedByIdentity(language, ids);
      owned.count.forEach((n, id) => counts.set(identityKey(language, id), n));
    }
    return page(slice.map((r) => toSummary(r, counts.get(identityKey(r.language, r.id)) ?? 0)), q.offset, q.limit, total);
  }

  async getCard(input: Input<typeof CardDetailQuery>): Promise<CardDetail> {
    return this.ctx.databases.consistentRead([parse(CardDetailQuery, input).language], () => this.getCardOnce(input));
  }

  private async getCardOnce(input: Input<typeof CardDetailQuery>): Promise<CardDetail> {
    const q = parse(CardDetailQuery, input);
    const db = await this.ctx.databases.catalog(q.language);
    if (!db) throw new NotFoundError('CatalogCard', q.cardId, `The ${q.language} catalog is not installed`);
    const row = (await db.select<CardRow>(CARD_COLS, `${CARD_FROM} WHERE c.language = ? AND c.id = ?`, [q.language, q.cardId]))[0];
    if (!row) throw new NotFoundError('CatalogCard', q.cardId);
    const user = this.ctx.databases.user;
    const total = Number(await user.scalar<number>('SELECT COUNT(*) FROM owned_cards WHERE language = ? AND catalog_card_id = ?', [q.language, q.cardId]));
    const idRows = await user.rows(
      'SELECT id FROM owned_cards WHERE language = ? AND catalog_card_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [q.language, q.cardId, q.limit, q.offset]
    );
    const hydrated = await hydrateOwned(this.ctx, idRows.map((r) => String(r[0])));
    const copies = idRows.map((r) => hydrated.get(String(r[0]))).filter((c): c is OwnedDto => c !== undefined);
    const history = copies
      .filter((c) => c.acquisition !== null)
      .map((c) => ({ acquisition: c.acquisition as NonNullable<OwnedDto['acquisition']>, purchasePrice: c.purchasePrice, ownedCardId: c.id }))
      .sort((a, b) => {
        const ad = a.acquisition.purchasedOn; const bd = b.acquisition.purchasedOn;
        if (ad !== bd) { if (ad === null) return 1; if (bd === null) return -1; return ad < bd ? 1 : -1; }
        return a.ownedCardId < b.ownedCardId ? -1 : 1;
      });
    const quotes: Quote[] = (await loadQuotes(this.ctx, [{ language: q.language, id: q.cardId }])).get(identityKey(q.language, q.cardId)) ?? [];
    return {
      ...toSummary(row, total), category: row.category, illustrator: row.illustrator, latestPrices: latestPerKey(quotes),
      ownedCopies: page(copies, q.offset, q.limit, total), purchaseHistory: history, syncedAt: row.syncedAt, detailSyncedAt: row.detailSyncedAt
    };
  }
}
