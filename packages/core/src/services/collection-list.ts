import { OwnedListQuery, type Currency, type Input, type OwnedDto, type Page } from '@flashydex/schemas';
import { nameSearch, localIdSort } from '../catalog/tcgdex';
import { valuationsFor, valueIn } from '../domain/valuation';
import { chunk } from '../db/sql';
import { ValidationError } from '../errors';
import { identityKey, loadQuotes, loadSeries, parse, readSettings, type ServiceContext } from './context';
import { hydrateOwned } from './owned-read';

type Variant = OwnedDto['variant'];
type Condition = NonNullable<OwnedDto['condition']>;

export type CollectionCardGroup = {
  source: 'catalog' | 'custom';
  language: 'en' | 'ja';
  cardId: string;
  variant: Variant;
  /** Matching copies only. */
  qty: number;
  copyIds: string[];
  /** Whole group, ignoring filters. */
  totalQty: number;
  allCopyIds: string[];
  representative: OwnedDto;
  variantDetails: Array<{ variantDetail: string; qty: number }>;
  conditions: Array<{ condition: Condition | null; qty: number }>;
  grading: { raw: number; graded: number };
};

type Light = {
  id: string; language: 'en' | 'ja'; catalogCardId: string | null; customCardId: string | null; setId: string | null; localId: string | null;
  nameSearch: string; variant: Variant; variantDetail: string; condition: Condition | null; graded: number; createdAt: string; updatedAt: string;
  manualCents: number | null; manualCurrency: Currency | null;
};

const LIGHT_COLS = {
  id: 'o.id', language: 'o.language', catalogCardId: 'o.catalog_card_id', customCardId: 'o.custom_card_id', setId: 'o.set_id', localId: 'o.local_id',
  nameSearch: 'o.name_search', variant: 'o.variant', variantDetail: 'o.variant_detail', condition: 'o.condition',
  graded: 'EXISTS (SELECT 1 FROM grades g WHERE g.owned_card_id = o.id)', createdAt: 'o.created_at', updatedAt: 'o.updated_at',
  manualCents: 'o.manual_price_cents', manualCurrency: 'o.manual_price_currency'
} as const;

const DUP_COUNT = `(SELECT COUNT(*) FROM owned_cards x WHERE x.language = o.language AND x.catalog_card_id IS o.catalog_card_id
    AND x.custom_card_id IS o.custom_card_id AND x.variant = o.variant AND x.variant_detail = o.variant_detail)`;

const groupKeyOf = (c: Light): string => `${c.catalogCardId !== null ? 'catalog' : 'custom'}\u0000${c.language}\u0000${c.catalogCardId ?? c.customCardId}\u0000${c.variant}`;
const newestFirst = (a: Light, b: Light): number => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1);
const CONDITION_ORDER: Array<Condition | null> = ['NM', 'LP', 'MP', 'HP', 'DMG', null];

/** Filters in SQL on the copy table; grouping/value/Pocket/priced logic in TS over lightweight rows; only the page is hydrated. */
export function listOwned(ctx: ServiceContext, rawInput: Input<typeof OwnedListQuery>): Promise<Page<CollectionCardGroup> | Page<OwnedDto>> {
  // R10: a user+catalog read captures collection revision + catalog epochs, retries once on movement, then STALE_READ.
  return ctx.databases.consistentRead(['en', 'ja'], () => listOwnedOnce(ctx, rawInput));
}

async function listOwnedOnce(ctx: ServiceContext, rawInput: Input<typeof OwnedListQuery>): Promise<Page<CollectionCardGroup> | Page<OwnedDto>> {
  const input = parse(OwnedListQuery, rawInput);
  if (input.groupBy === 'copy' && input.sort === 'count_desc') {
    throw new ValidationError('count_desc sorts grouped rows only', [{ path: 'sort', code: 'custom', message: "count_desc requires groupBy 'card'" }]);
  }
  const settings = await ctx.databases.user.read((q) => readSettings(q));
  const currency: Currency = input.currency ?? settings.defaultCurrency;
  const hidePocket = input.hideTcgPocket ?? settings.hideTcgPocket;

  const where: string[] = [];
  const params: unknown[] = [];
  if (input.q) { where.push('instr(o.name_search, ?) > 0'); params.push(nameSearch(input.q)); }
  if (input.localId !== undefined) { where.push('o.local_id = ?'); params.push(input.localId); }
  if (input.setId !== undefined) { where.push('o.set_id = ?'); params.push(input.setId); }
  if (input.rarity !== undefined) { where.push('o.rarity = ?'); params.push(input.rarity); }
  if (input.language !== undefined) { where.push('o.language = ?'); params.push(input.language); }
  if (input.condition === 'unknown') where.push('o.condition IS NULL');
  else if (input.condition !== undefined) { where.push('o.condition = ?'); params.push(input.condition); }
  if (input.grading === 'graded') where.push('EXISTS (SELECT 1 FROM grades g WHERE g.owned_card_id = o.id)');
  if (input.grading === 'raw') where.push('NOT EXISTS (SELECT 1 FROM grades g WHERE g.owned_card_id = o.id)');
  // Duplicate eligibility is the precise (identity, variant, detail) count over the WHOLE collection, independent of other filters.
  if (input.duplicates === true) where.push(`${DUP_COUNT} > 1`);
  if (input.duplicates === false) where.push(`${DUP_COUNT} = 1`);
  if (input.storageLocationId === 'none') where.push('o.storage_location_id IS NULL');
  else if (input.storageLocationId !== undefined) { where.push('o.storage_location_id = ?'); params.push(input.storageLocationId); }
  if (input.groupId !== undefined) { where.push('EXISTS (SELECT 1 FROM collection_group_members m WHERE m.owned_card_id = o.id AND m.collection_group_id = ?)'); params.push(input.groupId); }
  if (input.variant !== undefined) { where.push('o.variant = ?'); params.push(input.variant); }
  if (input.acquisitionId !== undefined) { where.push('o.acquisition_id = ?'); params.push(input.acquisitionId); }

  let copies = await ctx.databases.user.select<Light>(LIGHT_COLS, `FROM owned_cards o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  copies.forEach((c) => { c.graded = Number(c.graded); });

  if (hidePocket) {
    const sets = copies.filter((c) => c.catalogCardId !== null && c.setId !== null).map((c) => ({ language: c.language, setId: c.setId as string }));
    const series = await loadSeries(ctx, sets);
    copies = copies.filter((c) => c.catalogCardId === null || c.setId === null || series.get(identityKey(c.language, c.setId)) !== 'tcgp');
  }

  // Value is only needed for the priced filter and value sorts.
  let valueOf: ((c: Light) => number | null) | null = null;
  if (input.priced !== undefined || input.sort === 'value_desc' || input.sort === 'value_asc') {
    const quotes = await loadQuotes(ctx, copies.filter((c) => c.catalogCardId !== null).map((c) => ({ language: c.language, id: c.catalogCardId as string })));
    const cache = new Map<string, number | null>();
    valueOf = (c) => {
      const key = `${c.id}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      const manual = c.manualCents !== null && c.manualCurrency !== null ? { cents: c.manualCents, currency: c.manualCurrency } : null;
      const valuations = valuationsFor(
        { variant: c.variant, variantDetail: c.variantDetail, graded: c.graded === 1, manual, updatedAt: c.updatedAt },
        c.catalogCardId === null ? [] : (quotes.get(identityKey(c.language, c.catalogCardId)) ?? [])
      );
      const value = valueIn(valuations, currency);
      cache.set(key, value);
      return value;
    };
    if (input.priced !== undefined) {
      const wantPriced = input.priced === 'some';
      copies = copies.filter((c) => (valueOf!(c) !== null) === wantPriced);
    }
  }

  const { offset, limit } = input;
  const nullLast = (a: number | null, b: number | null, dir: 1 | -1): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a === b ? 0 : (a < b ? -1 : 1) * dir;
  };

  if (input.groupBy === 'copy') {
    const cmpSet = (a: Light, b: Light): number =>
      a.language.localeCompare(b.language) || nullLastStr(a.setId, b.setId) || (localIdSort(a.localId ?? '') < localIdSort(b.localId ?? '') ? -1 : localIdSort(a.localId ?? '') > localIdSort(b.localId ?? '') ? 1 : 0);
    copies.sort((a, b) => {
      let c = 0;
      if (input.sort === 'name_asc') c = a.nameSearch < b.nameSearch ? -1 : a.nameSearch > b.nameSearch ? 1 : 0;
      else if (input.sort === 'set_asc') c = cmpSet(a, b);
      else if (input.sort === 'value_desc') c = nullLast(valueOf!(a), valueOf!(b), -1);
      else if (input.sort === 'value_asc') c = nullLast(valueOf!(a), valueOf!(b), 1);
      else c = newestFirst(a, b);
      return c !== 0 ? c : a.id < b.id ? -1 : 1;
    });
    const total = copies.length;
    const slice = copies.slice(offset, offset + limit);
    const hydrated = await hydrateOwned(ctx, slice.map((c) => c.id));
    const data = slice.map((c) => hydrated.get(c.id)).filter((c): c is OwnedDto => c !== undefined);
    return { data, page: { offset, limit, total, hasMore: offset + data.length < total } };
  }

  // groupBy 'card'
  const groups = new Map<string, Light[]>();
  for (const copy of copies) {
    const key = groupKeyOf(copy);
    const list = groups.get(key);
    if (list) list.push(copy);
    else groups.set(key, [copy]);
  }
  type G = { key: string; copies: Light[]; rep: Light; value: number | null };
  const list: G[] = [...groups.entries()].map(([key, members]) => {
    members.sort(newestFirst);
    let value: number | null = null;
    if (valueOf) for (const m of members) { const v = valueOf(m); if (v !== null) value = (value ?? 0) + v; }
    return { key, copies: members, rep: members[0] as Light, value };
  });
  list.sort((a, b) => {
    let c = 0;
    if (input.sort === 'name_asc') c = a.rep.nameSearch < b.rep.nameSearch ? -1 : a.rep.nameSearch > b.rep.nameSearch ? 1 : 0;
    else if (input.sort === 'set_asc') {
      const la = localIdSort(a.rep.localId ?? ''); const lb = localIdSort(b.rep.localId ?? '');
      c = a.rep.language.localeCompare(b.rep.language) || nullLastStr(a.rep.setId, b.rep.setId) || (la < lb ? -1 : la > lb ? 1 : 0);
    } else if (input.sort === 'count_desc') c = b.copies.length - a.copies.length;
    else if (input.sort === 'value_desc') c = nullLast(a.value, b.value, -1);
    else if (input.sort === 'value_asc') c = nullLast(a.value, b.value, 1);
    else c = newestFirst(a.rep, b.rep);
    return c !== 0 ? c : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const total = list.length;
  const slice = list.slice(offset, offset + limit);
  const hydrated = await hydrateOwned(ctx, slice.map((g) => g.rep.id));
  const data: CollectionCardGroup[] = [];
  // R12: whole-group copy ids for the displayed groups in ONE chunked query (<= 50 groups per page), not one query per group.
  const wholeGroup = new Map<string, string[]>();
  for (const part of chunk(slice, 50)) {
    const clause = part.map(() => '(language = ? AND catalog_card_id IS ? AND custom_card_id IS ? AND variant = ?)').join(' OR ');
    const found = await ctx.databases.user.rows(
      `SELECT id, language, catalog_card_id, custom_card_id, variant FROM owned_cards WHERE ${clause} ORDER BY id ASC`,
      part.flatMap((g) => [g.rep.language, g.rep.catalogCardId, g.rep.customCardId, g.rep.variant])
    );
    for (const r of found) {
      const key = `${r[2] !== null ? 'catalog' : 'custom'}\u0000${String(r[1])}\u0000${String(r[2] ?? r[3])}\u0000${String(r[4])}`;
      const list = wholeGroup.get(key);
      if (list) list.push(String(r[0]));
      else wholeGroup.set(key, [String(r[0])]);
    }
  }
  for (const g of slice) {
    const rep = hydrated.get(g.rep.id);
    if (!rep) continue;
    const all = (wholeGroup.get(g.key) ?? []).map((id) => [id]);
    const details = new Map<string, number>();
    const conditions = new Map<Condition | null, number>();
    let graded = 0;
    for (const m of g.copies) {
      details.set(m.variantDetail, (details.get(m.variantDetail) ?? 0) + 1);
      conditions.set(m.condition, (conditions.get(m.condition) ?? 0) + 1);
      if (m.graded === 1) graded += 1;
    }
    data.push({
      source: g.rep.catalogCardId !== null ? 'catalog' : 'custom', language: g.rep.language, cardId: (g.rep.catalogCardId ?? g.rep.customCardId) as string,
      variant: g.rep.variant, qty: g.copies.length, copyIds: g.copies.map((m) => m.id).sort(), totalQty: all.length, allCopyIds: all.map((r) => String(r[0])),
      representative: rep,
      variantDetails: [...details.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([variantDetail, qty]) => ({ variantDetail, qty })),
      conditions: CONDITION_ORDER.filter((c) => conditions.has(c)).map((condition) => ({ condition, qty: conditions.get(condition) as number })),
      grading: { raw: g.copies.length - graded, graded }
    });
  }
  return { data, page: { offset, limit, total, hasMore: offset + data.length < total } };
}

function nullLastStr(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
