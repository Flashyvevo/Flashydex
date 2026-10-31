/** Raw TCGdex JSON as returned by api.tcgdex.net/v2 (only the fields the catalog mapper reads). */
export type CatalogLanguage = 'en' | 'ja';

export type RawJson = Record<string, unknown>;

export interface RawSetBrief extends RawJson {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
  cardCount?: { total?: number; official?: number };
}

export interface RawSetDetail extends RawSetBrief {
  releaseDate?: string;
  serie?: { id?: string; name?: string };
  cards?: Array<{ id: string; localId: string | number; name: string; image?: string }>;
}

export interface RawVariantRow extends RawJson {
  type?: string;
  subtype?: string;
  foil?: string;
  size?: string;
  stamp?: string[];
  variantId?: string;
  thirdParty?: { cardmarket?: number; tcgplayer?: number };
  pricing?: RawPricing | null;
}

export interface RawPricing extends RawJson {
  cardmarket?: RawJson | null;
  tcgplayer?: RawJson | null;
}

export interface RawCard extends RawJson {
  id: string;
  localId: string | number;
  name: string;
  category?: string;
  rarity?: string | null;
  illustrator?: string;
  image?: string;
  set: { id: string; name?: string };
  variants?: Record<string, boolean>;
  variants_detailed?: RawVariantRow[];
  pricing?: RawPricing | null;
  updated?: string;
}

/** Canonical variant enum from docs/DATA-MODEL.md (binding). */
export const CATALOG_VARIANTS = ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other'] as const;
export type CatalogVariant = (typeof CATALOG_VARIANTS)[number];
export const CATALOG_SOURCES = ['tcgplayer', 'cardmarket'] as const;
export type CatalogPriceSource = (typeof CATALOG_SOURCES)[number];

export interface MapContext {
  language: CatalogLanguage;
  /** ISO-8601 UTC instant stored in synced_at / detail_synced_at / captured_at. */
  syncedAt: string;
}

export interface MapWarning {
  code: string;
  cardId: string | null;
  message: string;
}

/** Row shapes mirror packages/core/src/db/catalog-schema.ts (snake_case columns -> camelCase fields). */
export interface CatalogSetRow {
  language: CatalogLanguage;
  id: string;
  name: string;
  nameSearch: string;
  series: string | null;
  status: 'published' | 'unpublished';
  releaseDate: string | null;
  officialCount: number | null;
  totalCount: number | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  rawJson: string;
  syncedAt: string;
}

export interface CatalogCardRow {
  language: CatalogLanguage;
  id: string;
  setId: string;
  localId: string;
  localIdSort: string;
  name: string;
  nameSearch: string;
  rarity: string | null;
  category: string | null;
  illustrator: string | null;
  imageUrl: string | null;
  hasNormal: boolean;
  hasHolo: boolean;
  hasReverse: boolean;
  hasFirstEdition: boolean;
  wPromo: boolean;
  availableVariantsJson: string;
  rawJson: string;
  syncedAt: string;
  detailSyncedAt: string | null;
}

export interface CatalogVariantRow {
  language: CatalogLanguage;
  cardId: string;
  variantKey: string;
  variant: CatalogVariant;
  variantDetail: string;
  providerVariantId: string | null;
  type: string;
  subtype: string | null;
  foil: string | null;
  size: string;
  stampsJson: string;
  attributesJson: string;
}

export interface CatalogLatestPriceRow {
  id: string;
  language: CatalogLanguage;
  catalogCardId: string;
  source: CatalogPriceSource;
  variant: CatalogVariant;
  variantDetail: string;
  providerVariantKey: string;
  currency: 'USD' | 'EUR';
  lowCents: number | null;
  midCents: number | null;
  highCents: number | null;
  marketCents: number | null;
  trendCents: number | null;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  observationKey: string;
}

export interface CatalogSetIndexEntry {
  language: CatalogLanguage;
  id: string;
  name: string;
  series: string | null;
  releaseDate: string | null;
  totalCount: number | null;
  officialCount: number | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  status: 'published' | 'unpublished';
}

export interface MappedCard {
  card: CatalogCardRow;
  variants: CatalogVariantRow[];
  prices: CatalogLatestPriceRow[];
  warnings: MapWarning[];
}
