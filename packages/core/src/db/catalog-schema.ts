/**
 * CATALOG database schema (catalog-en.db / catalog-ja.db), docs/DATA-MODEL.md "CATALOG DB" + Drizzle block.
 * One language per file; PK (language, id) everywhere; no FK to any user table; no personal data.
 *
 * The SQL in packages/core/migrations/catalog/ is generated from this file by drizzle-kit
 * (`npm run db:generate:catalog`); the sync test in packages/core/test/catalog-schema.test.ts asserts the
 * applied SQL matches these declarations.
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** Catalog schema generation gate (catalog_meta.schema_version). Bump together with a new migration file. */
export const CATALOG_SCHEMA_VERSION = 1;

export const CATALOG_LANGUAGES = ['en', 'ja'] as const;
export const CATALOG_SET_STATUSES = ['published', 'unpublished'] as const;
export const CATALOG_VARIANT_VALUES = ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other'] as const;
export const CATALOG_PRICE_SOURCES = ['tcgplayer', 'cardmarket'] as const;

export const catalogSets = sqliteTable('catalog_sets', {
  language: text('language', { enum: CATALOG_LANGUAGES }).notNull(),
  id: text('id').notNull(),
  name: text('name').notNull(),
  nameSearch: text('name_search').notNull(),
  // Provider serie.id (e.g. tcgp), not the translated serie.name.
  series: text('series'),
  status: text('status', { enum: CATALOG_SET_STATUSES }).notNull().default('unpublished'),
  releaseDate: text('release_date'),
  officialCount: integer('official_count'),
  totalCount: integer('total_count'),
  logoUrl: text('logo_url'),
  symbolUrl: text('symbol_url'),
  // Actual fetched set detail incl. the active `cards[]` manifest (`cards: []` for unpublished shells).
  rawJson: text('raw_json').notNull().default('{}'),
  syncedAt: text('synced_at').notNull()
}, (t) => [
  primaryKey({ columns: [t.language, t.id] }),
  index('cs_language_name').on(t.language, t.nameSearch, t.id),
  index('cs_visibility').on(t.status, t.series, t.language, t.id),
  check('cs_status', sql`${t.status} IN ('published','unpublished')`),
  check('cs_language', sql`${t.language} IN ('en','ja')`),
  check('cs_counts', sql`(${t.officialCount} IS NULL OR ${t.officialCount} >= 0)
    AND (${t.totalCount} IS NULL OR ${t.totalCount} >= 0)`)
]);

export const catalogCards = sqliteTable('catalog_cards', {
  language: text('language', { enum: CATALOG_LANGUAGES }).notNull(),
  id: text('id').notNull(),
  setId: text('set_id').notNull(),
  localId: text('local_id').notNull(),
  localIdSort: text('local_id_sort').notNull(),
  name: text('name').notNull(),
  nameSearch: text('name_search').notNull(),
  rarity: text('rarity'),
  category: text('category'),
  illustrator: text('illustrator'),
  imageUrl: text('image_url'), // Nullable CDN base: never derive a missing image URL.
  // Raw availability flags: false is not an owner prohibition. wPromo has no UI.
  hasNormal: integer('has_normal', { mode: 'boolean' }).notNull().default(false),
  hasHolo: integer('has_holo', { mode: 'boolean' }).notNull().default(false),
  hasReverse: integer('has_reverse', { mode: 'boolean' }).notNull().default(false),
  hasFirstEdition: integer('has_first_edition', { mode: 'boolean' }).notNull().default(false),
  wPromo: integer('w_promo', { mode: 'boolean' }).notNull().default(false),
  // Canonical Variant[] strings and raw provider flags/details remain separate.
  availableVariantsJson: text('available_variants_json').notNull().default('[]'),
  rawJson: text('raw_json').notNull().default('{}'),
  syncedAt: text('synced_at').notNull(),
  detailSyncedAt: text('detail_synced_at')
}, (t) => [
  primaryKey({ columns: [t.language, t.id] }),
  // CATALOG file: never reference the USER identity ledger across databases.
  foreignKey({ columns: [t.language, t.setId], foreignColumns: [catalogSets.language, catalogSets.id] })
    .onDelete('restrict').onUpdate('restrict'),
  uniqueIndex('cc_set_local').on(t.language, t.setId, t.localId),
  index('cc_name').on(t.nameSearch, t.language, t.id),
  index('cc_language_name').on(t.language, t.nameSearch, t.id),
  index('cc_set_sort').on(t.language, t.setId, t.localIdSort, t.id),
  index('cc_rarity').on(t.language, t.rarity),
  check('cc_language', sql`${t.language} IN ('en','ja')`),
  check('cc_flags', sql`${t.hasNormal} IN (0,1) AND ${t.hasHolo} IN (0,1)
    AND ${t.hasReverse} IN (0,1) AND ${t.hasFirstEdition} IN (0,1) AND ${t.wPromo} IN (0,1)`)
]);

export const catalogVariants = sqliteTable('catalog_variants', {
  language: text('language', { enum: CATALOG_LANGUAGES }).notNull(),
  cardId: text('card_id').notNull(),
  // SHA-256 of canonical JSON [type,subtype,foil,size,sortedNormalizedStamps]; NOT the provider variantId.
  variantKey: text('variant_key').notNull(),
  variant: text('variant', { enum: CATALOG_VARIANT_VALUES }).notNull(),
  variantDetail: text('variant_detail').notNull().default(''),
  providerVariantId: text('provider_variant_id'),
  type: text('type').notNull(),
  subtype: text('subtype'),
  foil: text('foil'),
  size: text('size').notNull(),
  stampsJson: text('stamps_json').notNull(),
  attributesJson: text('attributes_json').notNull()
}, (t) => [
  primaryKey({ columns: [t.language, t.cardId, t.variantKey] }),
  foreignKey({ columns: [t.language, t.cardId], foreignColumns: [catalogCards.language, catalogCards.id] })
    .onDelete('restrict').onUpdate('restrict'),
  index('cv_lookup').on(t.language, t.cardId, t.variant, t.variantDetail),
  check('cv_language', sql`${t.language} IN ('en','ja')`),
  check('cv_variant', sql`${t.variant} IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')`)
]);

// PriceSnapshot field shape; one LATEST observation per UNIQUE tuple at the frozen build cutoff.
export const catalogLatestPrices = sqliteTable('catalog_latest_prices', {
  // Deterministic: equals observation_key (builder-generated, no UUIDs in packs).
  id: text('id').notNull().primaryKey(),
  catalogCardId: text('catalog_card_id').notNull(),
  language: text('language', { enum: CATALOG_LANGUAGES }).notNull(),
  source: text('source', { enum: CATALOG_PRICE_SOURCES }).notNull(),
  variant: text('variant', { enum: CATALOG_VARIANT_VALUES }).notNull(),
  variantDetail: text('variant_detail').notNull().default(''),
  providerVariantKey: text('provider_variant_key').notNull(),
  currency: text('currency').notNull(),
  lowCents: integer('low_cents'),
  midCents: integer('mid_cents'),
  highCents: integer('high_cents'),
  marketCents: integer('market_cents'),
  trendCents: integer('trend_cents'),
  sourceUpdatedAt: text('source_updated_at'),
  capturedAt: text('captured_at').notNull(),
  // SHA-256 of [language,catalogCardId,source,variant,variantDetail,providerVariantKey,currency,sourceUpdatedAt,five cents].
  observationKey: text('observation_key').notNull()
}, (t) => [
  foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogCards.language, catalogCards.id] })
    .onDelete('restrict').onUpdate('restrict'),
  uniqueIndex('clp_observation').on(t.observationKey),
  uniqueIndex('clp_tuple').on(t.language, t.catalogCardId, t.source, t.variant, t.variantDetail, t.providerVariantKey, t.currency),
  index('clp_latest').on(t.language, t.catalogCardId, t.source, t.variant, t.variantDetail, t.providerVariantKey, t.currency, t.sourceUpdatedAt, t.capturedAt, t.id),
  check('clp_language', sql`${t.language} IN ('en','ja')`),
  check('clp_source_currency', sql`(${t.source} = 'tcgplayer' AND ${t.currency} = 'USD')
    OR (${t.source} = 'cardmarket' AND ${t.currency} = 'EUR')`),
  check('clp_variant', sql`${t.variant} IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')`),
  check('clp_low', sql`${t.lowCents} IS NULL OR ${t.lowCents} BETWEEN 0 AND 2147483647`),
  check('clp_mid', sql`${t.midCents} IS NULL OR ${t.midCents} BETWEEN 0 AND 2147483647`),
  check('clp_high', sql`${t.highCents} IS NULL OR ${t.highCents} BETWEEN 0 AND 2147483647`),
  check('clp_market', sql`${t.marketCents} IS NULL OR ${t.marketCents} BETWEEN 0 AND 2147483647`),
  check('clp_trend', sql`${t.trendCents} IS NULL OR ${t.trendCents} BETWEEN 0 AND 2147483647`)
]);

// Singleton row describing the immutable baseline build.
export const catalogMeta = sqliteTable('catalog_meta', {
  id: text('id').notNull().primaryKey(),
  language: text('language', { enum: CATALOG_LANGUAGES }).notNull(),
  version: text('version').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  builtAt: text('built_at').notNull(),
  builderVersion: text('builder_version').notNull(),
  sourceCutoffAt: text('source_cutoff_at').notNull(),
  sourceSetCount: integer('source_set_count').notNull(),
  sourceCardCount: integer('source_card_count').notNull(),
  sourceVariantCount: integer('source_variant_count').notNull(),
  sourcePriceCount: integer('source_price_count').notNull(),
  unpublishedSetCount: integer('unpublished_set_count').notNull(),
  schemaFingerprint: text('schema_fingerprint').notNull()
}, (t) => [
  check('catalog_singleton', sql`${t.id} = 'catalog'`),
  check('meta_language', sql`${t.language} IN ('en','ja')`),
  check('meta_schema_version', sql`${t.schemaVersion} >= 1`),
  check('meta_counts', sql`${t.sourceSetCount} >= 0 AND ${t.sourceCardCount} >= 0 AND ${t.sourceVariantCount} >= 0
    AND ${t.sourcePriceCount} >= 0 AND ${t.unpublishedSetCount} >= 0`)
]);

// Receipts of the CATALOG migration chain (trusted builder / core migrator). checksum = lowercase SHA-256 of the .sql bytes.
export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').notNull().primaryKey(), // e.g. 0000_initial
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull()
});

export type CatalogSetInsert = typeof catalogSets.$inferInsert;
export type CatalogCardInsert = typeof catalogCards.$inferInsert;
export type CatalogVariantInsert = typeof catalogVariants.$inferInsert;
export type CatalogLatestPriceInsert = typeof catalogLatestPrices.$inferInsert;
export type CatalogMetaInsert = typeof catalogMeta.$inferInsert;
