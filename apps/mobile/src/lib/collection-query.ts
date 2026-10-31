import { z } from 'zod';
import { parseCollectorQuery, type Condition, type Variant } from './format';

const flag = z.preprocess((v) => (v === true || v === 1 || v === '1' || v === 'true' ? true : undefined), z.boolean().optional());
const str = z.string().min(1).optional().catch(undefined);

export const SORTS = ['created_desc', 'name_asc', 'set_asc', 'value_desc', 'value_asc', 'count_desc'] as const;
export type SortKey = (typeof SORTS)[number];
export const SORT_LABEL: Record<SortKey, string> = {
  created_desc: 'Recently added',
  name_asc: 'Name A–Z',
  set_asc: 'Set & number',
  value_desc: 'Value high → low',
  value_asc: 'Value low → high',
  count_desc: 'Most copies'
};

/** `validateSearch` schema for /collection (UX §1.1). Bad values fall back to undefined, never crash. */
export const collectionSearch = z.object({
  q: str,
  view: z.enum(['grid', 'list']).optional().catch(undefined),
  sort: z.preprocess((v) => (v === 'recent' ? 'created_desc' : v), z.enum(SORTS).optional().catch(undefined)),
  set: str,
  rarity: str,
  lang: z.enum(['en', 'ja']).optional().catch(undefined),
  cond: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown', '?']).optional().catch(undefined),
  graded: z.enum(['raw', 'graded']).optional().catch(undefined),
  dupes: flag.catch(undefined),
  loc: str,
  group: str,
  variant: z.enum(['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other']).optional().catch(undefined),
  priced: z.enum(['none', 'some']).optional().catch(undefined),
  num: str,
  sheet: z.enum(['filters', 'sort']).optional().catch(undefined)
});
export type CollectionSearch = z.infer<typeof collectionSearch>;

export type Filters = Pick<CollectionSearch, 'set' | 'rarity' | 'lang' | 'cond' | 'graded' | 'dupes' | 'loc' | 'group' | 'variant' | 'priced' | 'num'>;
export const FILTER_KEYS = ['set', 'rarity', 'lang', 'cond', 'graded', 'dupes', 'loc', 'group', 'variant', 'priced', 'num'] as const satisfies readonly (keyof Filters)[];

export function pickFilters(s: CollectionSearch): Filters {
  const out: Filters = {};
  for (const k of FILTER_KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

export function countFilters(f: Filters): number {
  return FILTER_KEYS.filter((k) => f[k] !== undefined).length;
}

/** URL search → typed `CollectionRepo.list` input (aliases mapped here, never in core). */
export function toQuery(s: Filters & { q?: string; sort?: SortKey }) {
  const parsed = s.q ? parseCollectorQuery(s.q) : {};
  return {
    ...(parsed.q ? { q: parsed.q } : {}),
    ...(s.num ? { localId: s.num } : parsed.localId ? { localId: parsed.localId } : {}),
    ...(s.set ? { setId: s.set } : {}),
    ...(s.rarity ? { rarity: s.rarity } : {}),
    ...(s.lang ? { language: s.lang } : {}),
    ...(s.cond ? { condition: (s.cond === '?' ? 'unknown' : s.cond) as Condition | 'unknown' } : {}),
    ...(s.graded ? { grading: s.graded } : {}),
    ...(s.dupes ? { duplicates: true } : {}),
    ...(s.loc ? { storageLocationId: s.loc } : {}),
    ...(s.group ? { groupId: s.group } : {}),
    ...(s.variant ? { variant: s.variant as Variant } : {}),
    ...(s.priced ? { priced: s.priced } : {}),
    sort: s.sort ?? ('created_desc' as SortKey)
  };
}
