import { mapLatestPrices } from './prices';
import {
  imageBase, intOrNull, localIdSort, logoUrl, nameSearch, stringOrNull, symbolUrl
} from './text';
import type {
  CatalogSetIndexEntry, CatalogSetRow, MapContext, MappedCard, MapWarning, RawCard, RawSetBrief, RawSetDetail
} from './types';
import { availableVariants, classifyPrints, toVariantRow } from './variants';

/** Characters that need percent-encoding exactly once when an id is placed in a URL path (e.g. `SM1+`). */
export function encodeIdForPath(id: string): string {
  return encodeURIComponent(id);
}

/** Set detail -> catalog_sets row. Empty `cards: []` shells are `unpublished`; the manifest is stored in raw_json. */
export function mapSet(raw: RawSetDetail, ctx: MapContext): CatalogSetRow {
  const cards = Array.isArray(raw.cards) ? raw.cards : [];
  return {
    language: ctx.language,
    id: raw.id,
    name: raw.name,
    nameSearch: nameSearch(raw.name),
    series: stringOrNull(raw.serie?.id),
    status: cards.length > 0 ? 'published' : 'unpublished',
    releaseDate: stringOrNull(raw.releaseDate),
    officialCount: intOrNull(raw.cardCount?.official),
    totalCount: intOrNull(raw.cardCount?.total),
    logoUrl: logoUrl(raw.logo),
    symbolUrl: symbolUrl(raw.symbol, ctx.language),
    rawJson: JSON.stringify({ ...raw, cards }),
    syncedAt: ctx.syncedAt
  };
}

/** Bootstrap set-picker entry (needs the set DETAIL for series/releaseDate/status; the list brief lacks them). */
export function mapSetIndexEntry(raw: RawSetDetail | RawSetBrief, ctx: MapContext): CatalogSetIndexEntry {
  const row = mapSet(raw as RawSetDetail, ctx);
  return {
    language: row.language, id: row.id, name: row.name, series: row.series, releaseDate: row.releaseDate,
    totalCount: row.totalCount, officialCount: row.officialCount, logoUrl: row.logoUrl, symbolUrl: row.symbolUrl, status: row.status
  };
}

/** Full card detail -> card + variants + latest prices (+ warnings). Pure: no I/O, deterministic. */
export function mapCard(raw: RawCard, ctx: MapContext): MappedCard {
  const warnings: MapWarning[] = [];
  const flags = raw.variants ?? {};
  const prints = classifyPrints(raw.variants_detailed);
  const localId = String(raw.localId);
  const card = {
    language: ctx.language,
    id: raw.id,
    setId: raw.set.id,
    localId,
    localIdSort: localIdSort(localId),
    name: raw.name,
    nameSearch: nameSearch(raw.name),
    rarity: stringOrNull(raw.rarity),
    category: stringOrNull(raw.category),
    illustrator: stringOrNull(raw.illustrator),
    imageUrl: imageBase(raw.image),
    hasNormal: flags.normal === true,
    hasHolo: flags.holo === true,
    hasReverse: flags.reverse === true,
    hasFirstEdition: flags.firstEdition === true,
    wPromo: flags.wPromo === true,
    availableVariantsJson: JSON.stringify(availableVariants(flags)),
    rawJson: JSON.stringify(raw),
    syncedAt: ctx.syncedAt,
    detailSyncedAt: ctx.syncedAt
  };
  return {
    card,
    variants: prints.map((print) => toVariantRow(ctx.language, raw.id, print)),
    prices: mapLatestPrices(ctx.language, raw.id, prints, raw.pricing, ctx.syncedAt, warnings),
    warnings
  };
}
