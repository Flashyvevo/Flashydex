# FlashyDex — Phase 1 data model (Stage A2)

Normative schema target: packages/core/src/db/schema.ts. Repository DTOs use camelCase; SQL names snake_case. Schema, service invariants and mapping below form one contract with [API](API.md), [ARCHITECTURE](ARCHITECTURE.md), [IMPORT-EXPORT](IMPORT-EXPORT.md) and [PHASE1-ACCEPTANCE](PHASE1-ACCEPTANCE.md). No quantity column: each owned_cards row is one physical copy. Identity keys remain (language,id) where id is exact tcgdex_id, not a new renamed provider column. PostgreSQL is a possible server-side mirror later, never the device DB replacement.

## Portable types and conventions

| Drizzle SQLite declaration | SQLite storage | PostgreSQL equivalent |
|---|---|---|
| text() / text({enum: ...}) | TEXT | TEXT plus equivalent CHECK, NOT a PG native enum |
| text().primaryKey() | TEXT primary key, explicit NOT NULL | TEXT primary key |
| integer() | INTEGER | INTEGER |
| integer({mode:'boolean'}) | INTEGER 0/1 | BOOLEAN |
| ISO timestamp in text() | TEXT YYYY-MM-DDTHH:mm:ss.sssZ | TEXT initially, explicit future timestamptz migration |
| date-only text() | TEXT YYYY-MM-DD | TEXT initially, explicit future DATE migration |
| JSON serialized in text() | TEXT, zod validated at boundary | TEXT initially; JSONB optional later |

Every UUID is generated with crypto.randomUUID() by the service, not a dialect-specific DB default. All createdAt/updatedAt/capturedAt/syncedAt timestamps are explicit UTC ISO strings; creation sets both createdAt and updatedAt to the same instant. No implicit SQL now() or integer epoch types. Calendar dates validated as real dates, not regex alone. Monetary amounts are integer cents, range 0..2,147,483,647; all per-value currency fields uppercase ISO-4217 codes (Phase 1 writes USD/EUR only). NULL means unknown; 0 means known zero. Aggregates check Number.isSafeInteger and never silently overflow.

`language`: en | ja. Stable catalog identity is `(language,id)`; provider IDs are never prefixed, stripped, translated or normalized. `localId` is text; preserve leading zeros and letters. `nameSearch` is derived `name.normalize('NFKC').toLowerCase()`; local_id is NOT rewritten for import identity matching. `localIdSort` is a display-sort key derived by tokenizing digit runs and padding them to 12 digits; preserve original field. `variantDetail` is '' for standard variants, required user/catalog label for other, optional qualifier for first_edition, shadowless and promo_stamped; it distinguishes combinations such as first_edition + holo without inventing a reliable price mapping. No silent auto-selection based on flags.

## Pasteable Drizzle schema

```ts
import { sql } from 'drizzle-orm';
import {
  sqliteTable, text, integer, primaryKey, foreignKey, index, uniqueIndex, check,
} from 'drizzle-orm/sqlite-core';

export const LANGUAGES = ['en', 'ja'] as const;
export const VARIANTS = [
  'normal', 'holo', 'reverse_holo', 'first_edition',
  'promo_stamped', 'shadowless', 'other',
] as const;
export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'other'] as const;
export const SYNC_STATUSES = [
  'queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted',
] as const;
const id = () => text('id').notNull().primaryKey();
const created = () => text('created_at').notNull();
const updated = () => text('updated_at').notNull();

// Permanent minimal identity ledger. A metadata cache wipe does not delete this table.
export const catalogIdentities = sqliteTable('catalog_identities', {
  language: text('language', { enum: LANGUAGES }).notNull(),
  id: text('id').notNull(),
  createdAt: created(),
}, t => [
  primaryKey({ columns: [t.language, t.id] }),
  check('ci_language', sql`${t.language} IN ('en','ja')`),
]);

export const catalogSets = sqliteTable('catalog_sets', {
  language: text('language', { enum: LANGUAGES }).notNull(),
  id: text('id').notNull(),
  name: text('name').notNull(),
  nameSearch: text('name_search').notNull(),
  // Provider serie.id (e.g. tcgp), not the translated serie.name.
  series: text('series'),
  status: text('status', { enum: ['published', 'unpublished'] }).notNull().default('unpublished'),
  releaseDate: text('release_date'),
  officialCount: integer('official_count'),
  totalCount: integer('total_count'),
  logoUrl: text('logo_url'),
  symbolUrl: text('symbol_url'),
  rawJson: text('raw_json').notNull().default('{}'),
  syncedAt: text('synced_at').notNull(),
}, t => [
  primaryKey({ columns: [t.language, t.id] }),
  index('cs_language_name').on(t.language, t.nameSearch, t.id),
  index('cs_visibility').on(t.status, t.series, t.language, t.id),
  check('cs_status', sql`${t.status} IN ('published','unpublished')`),
  check('cs_language', sql`${t.language} IN ('en','ja')`),
  check('cs_counts', sql`(${t.officialCount} IS NULL OR ${t.officialCount} >= 0)
    AND (${t.totalCount} IS NULL OR ${t.totalCount} >= 0)`),
]);

export const catalogCards = sqliteTable('catalog_cards', {
  language: text('language', { enum: LANGUAGES }).notNull(),
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
  detailSyncedAt: text('detail_synced_at'),
}, t => [
  primaryKey({ columns: [t.language, t.id] }),
  foreignKey({ columns: [t.language, t.id], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
    .onDelete('restrict').onUpdate('restrict'),
  foreignKey({ columns: [t.language, t.setId], foreignColumns: [catalogSets.language, catalogSets.id] })
    .onDelete('restrict').onUpdate('restrict'),
  uniqueIndex('cc_set_local').on(t.language, t.setId, t.localId),
  index('cc_name').on(t.nameSearch, t.language, t.id),
  index('cc_language_name').on(t.language, t.nameSearch, t.id),
  index('cc_set_sort').on(t.language, t.setId, t.localIdSort, t.id),
  index('cc_rarity').on(t.language, t.rarity),
  check('cc_language', sql`${t.language} IN ('en','ja')`),
  check('cc_flags', sql`${t.hasNormal} IN (0,1) AND ${t.hasHolo} IN (0,1)
    AND ${t.hasReverse} IN (0,1) AND ${t.hasFirstEdition} IN (0,1) AND ${t.wPromo} IN (0,1)`),
]);

export const customCards = sqliteTable('custom_cards', {
  id: id(),
  name: text('name').notNull(),
  nameSearch: text('name_search').notNull(),
  setId: text('set_id'),
  setName: text('set_name'),
  localId: text('local_id'),
  language: text('language', { enum: LANGUAGES }).notNull(),
  rarity: text('rarity'),
  imageUrl: text('image_url'),
  notes: text('notes'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [
  index('custom_name').on(t.nameSearch, t.id),
  check('custom_language', sql`${t.language} IN ('en','ja')`),
]);

export const acquisitions = sqliteTable('acquisitions', {
  id: id(),
  purchasedOn: text('purchased_on'),
  source: text('source'),
  notes: text('notes'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [index('acq_date').on(t.purchasedOn, t.id)]);

export const storageLocations = sqliteTable('storage_locations', {
  id: id(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  description: text('description'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [uniqueIndex('storage_name_key').on(t.nameKey)]);

export const collectionGroups = sqliteTable('collection_groups', {
  id: id(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  description: text('description'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [uniqueIndex('group_name_key').on(t.nameKey)]);

// Stable seam only. No scan images, camera or recognition processing in Phase 1.
export const scanSessions = sqliteTable('scan_sessions', {
  id: id(),
  status: text('status', { enum: ['open', 'closed', 'abandoned'] }).notNull().default('open'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  notes: text('notes'),
}, t => [
  index('scan_started').on(t.startedAt, t.id),
  check('scan_status', sql`${t.status} IN ('open','closed','abandoned')`),
  check('scan_closed_at', sql`(${t.status} = 'open' AND ${t.endedAt} IS NULL)
    OR (${t.status} <> 'open' AND ${t.endedAt} IS NOT NULL)`),
]);

export const ownedCards = sqliteTable('owned_cards', {
  id: id(),
  catalogCardId: text('catalog_card_id'),
  customCardId: text('custom_card_id').references(() => customCards.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  // Personal display snapshot: never overwritten by sync or a custom-card edit.
  name: text('name').notNull(),
  nameSearch: text('name_search').notNull(),
  setId: text('set_id'),
  setName: text('set_name'),
  localId: text('local_id'),
  language: text('language', { enum: LANGUAGES }).notNull(),
  rarity: text('rarity'),
  imageUrl: text('image_url'),
  variant: text('variant', { enum: VARIANTS }).notNull().default('normal'),
  variantDetail: text('variant_detail').notNull().default(''),
  condition: text('condition', { enum: CONDITIONS }),
  acquisitionId: text('acquisition_id').references(() => acquisitions.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
  purchasePriceCents: integer('purchase_price_cents'),
  purchaseCurrency: text('purchase_currency'),
  storageLocationId: text('storage_location_id').references(() => storageLocations.id, { onDelete: 'set null', onUpdate: 'restrict' }),
  scanSessionId: text('scan_session_id').references(() => scanSessions.id, { onDelete: 'set null', onUpdate: 'restrict' }),
  notes: text('notes'),
  manualPriceCents: integer('manual_price_cents'),
  manualPriceCurrency: text('manual_price_currency'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [
  foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
    .onDelete('restrict').onUpdate('restrict'),
  index('owned_catalog_variant').on(t.language, t.catalogCardId, t.variant, t.variantDetail),
  index('owned_custom_variant').on(t.customCardId, t.variant, t.variantDetail),
  index('owned_name').on(t.nameSearch, t.id),
  index('owned_set').on(t.language, t.setId, t.localId),
  index('owned_filters').on(t.language, t.condition, t.rarity),
  index('owned_storage').on(t.storageLocationId),
  index('owned_acquisition').on(t.acquisitionId),
  index('owned_scan').on(t.scanSessionId),
  index('owned_created').on(t.createdAt, t.id),
  check('owned_one_reference', sql`(${t.catalogCardId} IS NOT NULL AND ${t.customCardId} IS NULL)
    OR (${t.catalogCardId} IS NULL AND ${t.customCardId} IS NOT NULL)`),
  check('owned_language', sql`${t.language} IN ('en','ja')`),
  check('owned_catalog_snapshot', sql`${t.catalogCardId} IS NULL OR (${t.setId} IS NOT NULL AND ${t.localId} IS NOT NULL)`),
  check('owned_variant', sql`${t.variant} IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')`),
  check('owned_variant_detail', sql`${t.variant} <> 'other' OR length(trim(${t.variantDetail})) > 0`),
  check('owned_condition', sql`${t.condition} IS NULL OR ${t.condition} IN ('NM','LP','MP','HP','DMG')`),
  check('owned_purchase', sql`(${t.purchasePriceCents} IS NULL AND ${t.purchaseCurrency} IS NULL)
    OR (${t.purchasePriceCents} IS NOT NULL AND ${t.purchaseCurrency} IS NOT NULL
      AND ${t.purchasePriceCents} BETWEEN 0 AND 2147483647 AND ${t.purchaseCurrency} IN ('USD','EUR'))`),
  check('owned_manual', sql`(${t.manualPriceCents} IS NULL AND ${t.manualPriceCurrency} IS NULL)
    OR (${t.manualPriceCents} IS NOT NULL AND ${t.manualPriceCurrency} IS NOT NULL
      AND ${t.manualPriceCents} BETWEEN 0 AND 2147483647 AND ${t.manualPriceCurrency} IN ('USD','EUR'))`),
]);

// Presence of this row means graded. No redundant is_graded flag to drift.
export const grades = sqliteTable('grades', {
  id: id(),
  ownedCardId: text('owned_card_id').notNull().references(() => ownedCards.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
  company: text('company', { enum: GRADING_COMPANIES }).notNull(),
  companyLabel: text('company_label'),
  grade: text('grade').notNull(),
  certNumber: text('cert_number'),
  notes: text('notes'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [
  uniqueIndex('grade_copy').on(t.ownedCardId),
  index('grade_company').on(t.company),
  index('grade_cert').on(t.company, t.certNumber),
  check('grade_company_valid', sql`${t.company} IN ('PSA','BGS','CGC','SGC','ACE','TAG','other')`),
  check('grade_other_label', sql`${t.company} <> 'other' OR (${t.companyLabel} IS NOT NULL AND length(trim(${t.companyLabel})) > 0)`),
]);

export const collectionGroupMembers = sqliteTable('collection_group_members', {
  collectionGroupId: text('collection_group_id').notNull().references(() => collectionGroups.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
  ownedCardId: text('owned_card_id').notNull().references(() => ownedCards.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
}, t => [
  primaryKey({ columns: [t.collectionGroupId, t.ownedCardId] }),
  index('member_copy').on(t.ownedCardId),
]);

export const priceSnapshots = sqliteTable('price_snapshots', {
  id: id(),
  catalogCardId: text('catalog_card_id').notNull(),
  language: text('language', { enum: LANGUAGES }).notNull(),
  source: text('source', { enum: ['tcgplayer', 'cardmarket'] }).notNull(),
  variant: text('variant', { enum: VARIANTS }).notNull(),
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
  // SHA-256 of canonical identity+source+variant+currency+sourceUpdatedAt+five values.
  observationKey: text('observation_key').notNull(),
}, t => [
  foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
    .onDelete('restrict').onUpdate('restrict'),
  uniqueIndex('price_observation').on(t.observationKey),
  index('price_latest').on(t.language, t.catalogCardId, t.variant, t.variantDetail, t.currency, t.source, t.capturedAt, t.id),
  check('price_language', sql`${t.language} IN ('en','ja')`),
  check('price_source_currency', sql`(${t.source} = 'tcgplayer' AND ${t.currency} = 'USD')
    OR (${t.source} = 'cardmarket' AND ${t.currency} = 'EUR')`),
  check('price_variant', sql`${t.variant} IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')`),
  check('price_low', sql`${t.lowCents} IS NULL OR ${t.lowCents} BETWEEN 0 AND 2147483647`),
  check('price_mid', sql`${t.midCents} IS NULL OR ${t.midCents} BETWEEN 0 AND 2147483647`),
  check('price_high', sql`${t.highCents} IS NULL OR ${t.highCents} BETWEEN 0 AND 2147483647`),
  check('price_market', sql`${t.marketCents} IS NULL OR ${t.marketCents} BETWEEN 0 AND 2147483647`),
  check('price_trend', sql`${t.trendCents} IS NULL OR ${t.trendCents} BETWEEN 0 AND 2147483647`),
]);

export const syncState = sqliteTable('sync_state', {
  id: id(),
  status: text('status', { enum: SYNC_STATUSES }).notNull().default('queued'),
  mode: text('mode', { enum: ['incremental', 'refresh', 'prices_only'] }).notNull().default('incremental'),
  languagesJson: text('languages_json').notNull(),
  selectionJson: text('selection_json').notNull(), // Frozen all/followed selection; see checkpoint v2.
  lockKey: text('lock_key'),
  workerToken: text('worker_token'),
  attempt: integer('attempt').notNull().default(1),
  setsTotal: integer('sets_total'),
  setsDone: integer('sets_done').notNull().default(0),
  cardsTotal: integer('cards_total'),
  cardsDone: integer('cards_done').notNull().default(0),
  cardsFailed: integer('cards_failed').notNull().default(0),
  checkpointJson: text('checkpoint_json').notNull().default('{}'),
  lastErrorJson: text('last_error_json'),
  heartbeatAt: text('heartbeat_at'),
  leaseExpiresAt: text('lease_expires_at'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [
  uniqueIndex('sync_lock').on(t.lockKey),
  index('sync_created').on(t.createdAt, t.id),
  check('sync_status', sql`${t.status} IN ('queued','running','cancel_requested','completed','failed','cancelled','interrupted')`),
  check('sync_mode', sql`${t.mode} IN ('incremental','refresh','prices_only')`),
  check('sync_lock_value', sql`${t.lockKey} IS NULL OR ${t.lockKey} = 'catalog'`),
  check('sync_counts', sql`${t.attempt} >= 1 AND ${t.setsDone} >= 0 AND ${t.cardsDone} >= 0 AND ${t.cardsFailed} >= 0
    AND (${t.setsTotal} IS NULL OR ${t.setsTotal} >= ${t.setsDone})
    AND (${t.cardsTotal} IS NULL OR ${t.cardsTotal} >= ${t.cardsDone} + ${t.cardsFailed})`),
]);

// Operational receipt, committed atomically with an import. Not personal export data.
export const dataOperationReceipts = sqliteTable('data_operation_receipts', {
  id: id(),
  operation: text('operation', { enum: ['import'] }).notNull(),
  planHash: text('plan_hash').notNull(),
  resultJson: text('result_json').notNull(),
  committedAt: text('committed_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, t => [
  index('receipt_expiry').on(t.expiresAt),
  check('receipt_operation', sql`${t.operation} = 'import'`),
]);

// Singleton, seeded id='collection'. Not an account/user model.
export const appState = sqliteTable('app_state', {
  id: id(),
  collectionRevision: integer('collection_revision').notNull().default(0),
  updatedAt: updated(),
}, t => [
  check('app_singleton', sql`${t.id} = 'collection'`),
  check('app_revision', sql`${t.collectionRevision} >= 0`),
]);

export const appSettings = sqliteTable('app_settings', {
  id: id(), // singleton 'app', not an account
  languagesJson: text('languages_json').notNull().default('["en","ja"]'),
  setsFollowedJson: text('sets_followed_json').notNull().default('[]'),
  syncAllSets: integer('sync_all_sets', { mode: 'boolean' }).notNull().default(false),
  hideTcgPocket: integer('hide_tcg_pocket', { mode: 'boolean' }).notNull().default(true),
  defaultCurrency: text('default_currency', { enum: ['USD', 'EUR'] }).notNull().default('USD'),
  disclaimerAcknowledged: integer('disclaimer_acknowledged', { mode: 'boolean' }).notNull().default(false),
  disclaimerAcknowledgedAt: text('disclaimer_acknowledged_at'),
  onboardingCompletedAt: text('onboarding_completed_at'),
  updatedAt: updated(),
}, t => [
  check('settings_singleton', sql`${t.id} = 'app'`),
  check('settings_currency', sql`${t.defaultCurrency} IN ('USD','EUR')`),
  check('settings_booleans', sql`${t.syncAllSets} IN (0,1) AND ${t.hideTcgPocket} IN (0,1)
    AND ${t.disclaimerAcknowledged} IN (0,1)`),
  check('settings_disclaimer', sql`(${t.disclaimerAcknowledged} = 0 AND ${t.disclaimerAcknowledgedAt} IS NULL)
    OR (${t.disclaimerAcknowledged} = 1 AND ${t.disclaimerAcknowledgedAt} IS NOT NULL)`),
]);

// Core migrator's bootstrap table: not owned by the plugin version-upgrade system.
export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').notNull().primaryKey(), // e.g. 0001_initial
  checksum: text('checksum').notNull(), // lowercase SHA-256 of bundled SQL bytes
  appliedAt: text('applied_at').notNull(),
});
```

Schema block is complete for Phase 1. `text({enum})` supplies TS inference only; SQL CHECKs above enforce enum integrity. Nullable money-pair checks use explicit non-null branches to avoid SQLite/PG three-valued CHECK semantics accepting a partial pair. API/service validation repeats these constraints for useful errors.

## Entity meanings and additional service constraints

- CatalogSet: provider count metadata, not a count of owned rows. Metadata primary key includes language. Logo/symbol are full URLs, e.g. base + .webp; card image base becomes /high.webp (client may request /low.webp by a tested asset helper). All optional upstream values remain NULL.
- CatalogCard: cache fields needed for search/details plus full raw provider JSON for optional HP/types/attacks/variant details. API exposes named core fields, not arbitrary rawJson. Missing variant flags do not imply normal=true. No detail required for viewing a brief record; detailSyncedAt distinguishes completeness.
- CustomCard: reusable manual identity, nullable set/localId when unknown. No uniqueness by name: visually similar or same-named cards may differ. Edit affects its definition, not existing OwnedCard snapshots. DELETE while referenced -> 409 IN_USE. No silent conversion of custom cards on resync.
- OwnedCard: copy, no quantity. Initial snapshot copied from catalog/custom definition in the same transaction, or accepted from a validated import when metadata unavailable. Catalog source requires setId/localId; setName is nullable if unknown. No collection->catalog-cache join required for rendering. Changing the identity or snapshot of an existing copy is not allowed by ordinary PATCH; delete/re-add or explicit import conflict update is intentional and auditable through preview. Service checks customCard.language equals copy.language. trim/length constraints: names 1..200, ids/provider keys 1..200, localId <=80, rarity <=100, variantDetail <=120, source <=200, notes/description <=5000, URLs <=2048. Empty optional text normalizes to NULL, except variantDetail which uses ''.
- Acquisition: purchase event (date/source/notes), shared across copies from one purchase; cost is per copy on OwnedCard, NOT repeated transaction total. For mixed lots owner allocates cost explicitly; never divide a lot price silently. A standalone copy with date/source creates an acquisition; attaching to an existing event shares its date/source intentionally. Copy-level price may be NULL even with an event; known price does not require a known date. Delete referenced acquisition -> 409 IN_USE, not SET NULL that destroys purchase history. Editing event changes the shared date/source for its copies; UI must explain this.
- Grade: at most one per copy, nullable cert (not globally unique: incomplete data and duplicates must be importable). Company=other requires companyLabel; other companyLabel is NULL. `grade` nonempty text <=16 (numeric such as '9.5' or certificate label 'Authentic'); do not coerce labels to a float. Grade is not a pricing multiplier. grade=null on PATCH deletes grade; replacing grade preserves existing grade UUID; new grade gets new UUID.
- StorageLocation and CollectionGroup: nameKey=NFKC trimmed lowercase for case-insensitive uniqueness, display name preserved. Storage deletion sets owned location to NULL in one transaction and increments revision; group deletion deletes memberships only. Explicit confirmation in UI with affected count. No nesting in Phase 1.
- CollectionGroupMember: many-to-many physical copy memberships; aggregate group quantities by counting member copy rows, never quantities stored on groups.
- ScanSession: table exists but Phase 1 UI/API cannot create scans. Import/export can preserve rows from supported v1 files. endedAt >= startedAt if present. Deleting a future session cannot delete owned copies.
- PriceSnapshot: immutable source observation, not current price overwritten on sync. FK targets identity ledger so history survives cache wipe. Observation key = SHA-256 of UTF-8 JSON array `[language,catalogCardId,source,variant,variantDetail,providerVariantKey,currency,sourceUpdatedAt,lowCents,midCents,highCents,marketCents,trendCents]` in exactly that order, no whitespace. No capturedAt in key; repeated identical observations with absent provider date do not grow history. On semantic key conflict retain existing UUID/capturedAt. Validate provider date to UTC, use NULL when invalid/missing; capturedAt always local observation time. Latest within a source/variant uses sourceUpdatedAt DESC NULLS LAST, then capturedAt DESC,id DESC (SQL expression equivalent for SQLite; never let an older provider quote outrank a newer one just because import captured later).
- SyncState: operational, no owned lifetime dependency. See checkpoint v2 below. workerToken is an app executor fencing token, never exposed to UI; no Node worker. lastErrorJson contains safe DomainError data, not paths/private data. Selection is frozen at start; resume may not change it. Sync never writes AppSettings or personal rows.
- AppSettings: singleton id='app'; languagesJson is a distinct nonempty Language[]; setsFollowedJson is a distinct Array<{language:Language,setId:string}>, each language selected. syncAllSets=false with no followed sets is valid preference but cannot start a sync; user chooses sets or all. hideTcgPocket applies to known series='tcgp' in catalog/collection lists, never deletes data or excludes dashboard/export/backup totals implicitly. Unknown catalog series (e.g. offline imported snapshots after cache wipe) is retained and shown, not guessed from card IDs. defaultCurrency USD/EUR changes display/no-price filter, never converts money. Acknowledgement/time pair and onboarding time validated; setting disclaimer acknowledgement supplies current timestamp, clearing clears it. Settings edits persist but do NOT increment collectionRevision or invalidate personal import plans. JSON v1 deliberately does not include app settings; full raw DB does. Privacy/disclaimer remains readable when not acknowledged.
- SchemaMigration: ordered migration name, SHA-256 SQL checksum and UTC appliedAt. Operational, excluded from portable JSON; migration/restore rules below are binding.
- DataOperationReceipt: operation id equals import preview UUID, planHash exact lowercase SHA-256; resultJson validated ImportCommitResult. Insert with personal changes in SAME transaction. Retry same UUID/hash returns result, different hash ->409 CONFLICT. Required to close crash window between DB commit and staged-file status update. expiresAt=committedAt+24h; cleanup is operational, not a collection revision. Not exported in JSON/CSV; full SQLite backup naturally includes it.
- AppState: every successful personal-data mutation (including a delete that changes FK dependants, price override, acquisition/group/storage/custom/grade edits, import) increments revision ONCE per transaction. No-op idempotent membership/import retries may leave it unchanged. Sync, backup and GET never increment it. This revision prevents committing an outdated import/restore preview; it is not per-copy optimistic concurrency or a multi-user model.

There are no unspecified defaults: absent nullable columns are SQL NULL, nonnullable columns without `.default` must be supplied by the service. Primary keys, all declared unique/index definitions and FK actions in the block are normative; FK update action is always RESTRICT. No catalog-to-personal DELETE CASCADE exists. Only child Grade/membership data cascade with their personal parent.

## Variants and source reconciliation

Canonical enum is exactly `normal | holo | reverse_holo | first_edition | promo_stamped | shadowless | other`. TCGdex booleans: normal->normal; holo->holo; reverse->reverse_holo; firstEdition->first_edition; wPromo->promo_stamped. True advertises availability; false/missing doesn't prohibit an explicit manual choice. Unknown detailed variant types become other with raw type/size as nonempty variantDetail. Preserve raw provider variantId in raw JSON, not as a canonical enum.

TCGdex row-to-variant-to-price mapping is binding (research is evidence, not a competing enum). Resolve detailed rows by type/subtype/normalized stamp/foil/size, NOT array order or variantId (not unique). Normalize stamp case/hyphen/space for matching but preserve raw JSON. Canonical Variant stays unchanged; variantDetail represents qualified prints, including reverse_holo + 'pokeball'/'masterball', holo + 'gold'/'unlimited', first_edition + 'holo'/'normal'/'shadowless:holo', shadowless + 'holo'/'normal', promo_stamped + canonical stamp list, other + explicit size/subtype/type qualifier. Ordinary normal/holo/reverse_holo use ''. Qualifiers are exact normalized strings from matched print attributes, <=120 chars; UI may select confirmed custom qualifier. Never use arbitrary substring matching to pick a price.

| Detailed print / canonical choice | TCGplayer key ON THAT matched product | Cardmarket value |
|---|---|---|
| normal, unqualified | normal | avg |
| holo, unqualified | holofoil | avg if avg-holo null, otherwise avg-holo |
| reverse_holo, plain | reverse-holofoil | avg-holo, or avg only when that distinct print has no avg-holo |
| first_edition + normal | 1st-edition (also legacy 1st-edition-normal if actually present) | matched row avg / foil rule |
| first_edition + holo | 1st-edition-holofoil | matched row foil rule |
| normal/holo + unlimited | unlimited / unlimited-holofoil respectively | matched unlimited row only |
| shadowless or first_edition + shadowless qualifier | exact key only if explicitly present on matched row; otherwise null | matched product; shared product means shared price, never invent split |
| reverse_holo + pokeball/masterball | holofoil on ball-specific product, NOT reverse-holofoil on base product | avg-holo when present, otherwise numeric avg on exact print |
| holo + gold | holofoil on matched product | numeric avg when avg-holo null |
| promo_stamped / other (jumbo, no-rarity, copyright etc.) | only explicitly identified key/product, otherwise null | numeric exact-print foil/avg rule, otherwise null |

TCGplayer fields low/mid/high/market map from lowPrice/midPrice/highPrice/marketPrice; trend null. Effective USD value = market then mid then null, NEVER low/directLow fallback. Cardmarket low maps low, avg maps mid, trend maps trend from selected suffix; effective EUR = mid (avg) then null, not trend/low invented fallback. Preserve these auxiliary fields for display/history. When both avg and avg-holo exist choose nonfoil/foil correctly; if only avg exists on an exact holo print, it is that print's value. Ambiguous shared foil quote when both holo/reverse exist is stored other + 'cardmarket_holo_unspecified', never auto-applied. No fallback to another detailed row, currency, grade or root product. Root pricing fallback allowed ONLY if one detailed row and exact print mapping is unambiguous. Repeated blocks dedupe by semantic source/variant/qualifier/product key; providerVariantKey is deterministic `<productId>:<priceKey>:<normalizedPrintQualifier>` for qualified/product-specific quotes (legacy simple keys remain readable). This prevents ball/staff/subtype prices colliding under bare holofoil. observationKey includes it. Unknown keys retained raw and may be other/display-only. Invalid/negative/absent price ->null+warning; genuine zero stays0. Decimal half-up cents parsing, no binary multiply/truncate. No scraping.

Manual override is per physical copy (`manualPriceCents`, `manualPriceCurrency`); setting both NULL clears. User-provided value applies equally to raw/graded and remains unchanged by sync. It is valuation data, not a fake marketplace PriceSnapshot.

## Definitions for every screen and aggregate

- Total cards = COUNT(owned_cards), not group count.
- Unique cards = number of distinct `(identity,variant,variantDetail)` groups. Language is in catalog identity; custom UUIDs remain distinct from catalog identities. Condition, grade, storage and price do not split duplicates.
- Duplicates = SUM(max(groupCount-1,0)); a triple is two extras, not three. Each copy response also has duplicateCount=groupCount (including itself) so duplicate filter is count>1. Filter grouping occurs across the whole collection BEFORE applying condition/storage/etc filters.
- Set ownedCount = count of catalog-sourced copies whose snapshot language/setId match the set; custom copies are reported separately as customOwnedCount and do not contribute to official completion. Set ownedUnique = number of catalog cards in the active set manifest with any owned identity match (ignores variants). Catalog cards with multiple variants still count once. Missing = metadata cards with zero copies. Duplicate extras on a set = sum of extras by catalog identity+variant+detail in that set, excludes custom cards.
- Set totalCount = upstream total; catalogCount = count of cached metadata rows whose IDs are in the active fetched manifest (0 if no manifest yet). completionPercent = round(100 * ownedUnique/catalogCount, 2) only when catalogCount>0 AND catalogComplete=true; otherwise NULL. catalogComplete means the fetched set manifest is stored and all its brief rows are present (`catalogCount === totalCount` is NOT sufficient alone when counts differ upstream). Derive manifest enumeration from set rawJson.cards, with ids unique; all enumerated ids present and no unfinished manifest for the set. Extra cached cards removed upstream are excluded from that active manifest for completion/missing results, not deleted. While incomplete expose loaded counts and 'Catalog incomplete', not a false 100%. officialCount is informational; secret/extra cards in manifest are included in denominator.
- Per-currency valuation: for each USD/EUR return estimatedValueCents (NULL if no valued copies), valuedCopies, unvaluedCopies, totalPaidCents (NULL if no known paid copies in that currency), knownCostCopies, comparableCopies, comparableCostCents, comparableValueCents, gainLossCents. Estimated value includes only known values in that currency; manual override's currency replaces ALL automatic valuations for that copy. Raw automatic quotes can produce separate USD and EUR estimates, never added together. Paid amounts appear only in their recorded currency. Gain/loss is SUM(value-cost) on intersection of valued copies and known cost in SAME currency; NULL if intersection empty. Label this comparable subset, not full portfolio profit. All-null portfolio isn't $0; empty collection is total 0 and currency amounts NULL with zero coverage.
- Recent copies = createdAt DESC,id DESC, limit 10; stable imported historical createdAt is preserved. Purchase history = acquisition event and per-copy paid fields for owned copies of identity, newest purchasedOn first with unknown dates last.

## SQLite driver compatibility and migrations

Every schema field uses TEXT or INTEGER, nulls, bounded JS numbers, 0/1 booleans and explicit constraints. These are supported by @capacitor-community/sqlite native and its sql.js/jeep-sqlite web adapter through sqlite-proxy; no better-sqlite3-only repository feature, native enum/Date/BigInt/Buffer binding, JSON1/FTS/rowid query dependency, synchronous API or extension loading. JSON is serialized TEXT and validated in zod, not queried through SQLite JSON functions. Use IN chunks <=400 bound values and avoid a platform's variable-count ceiling. Foreign keys enabled/verified on each opened connection. Schema CHECK booleans are SQL integers; proxy/Drizzle boolean codec maps to TS boolean.

Verified upstream v7.0.3 [API](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/docs/API.md) / [definitions](https://raw.githubusercontent.com/capacitor-community/sqlite/v7.0.3/src/definitions.ts): run and query accept a SINGLE statement, execute accepts raw batch, executeSet takes separate statements/values; explicit transaction API exists and DML defaults to transaction=true. Pass false to inner operations within core UnitOfWork. The API documents Changes.values for RETURNING but returnMode options carry Electron-specific wording; this is NOT enough to assert native/web parity. Phase1 forbids reliance on RETURNING: generated UUID + SELECT in same transaction instead. No blanket claim that SQLite itself lacks RETURNING. get/all/values proxy result row shape and iOS ios_columns normalization must be parity-tested; use explicit ordered projections, including null/0/aliases/aggregates. Node tests construct SAME sqlite-proxy with better-sqlite3 behind driver, never change ORM dialect.

Migrations live as ordered .sql files in packages/core/migrations/ (e.g. 0001_initial.sql); drizzle-kit generation is development-only. Core bundles file bytes/checksums, bootstraps schema_migrations, orders filenames lexicographically, verifies applied prefix/checksums and refuses newer/unknown/drifted schemas. Apply one file's statements and tracking row within ONE explicit transaction; no nested auto-transactions. Split only generator statement-breakpoint markers using a tested loader (a statement can contain quoted semicolons); reject multiple unseparated statements instead of handing them to run/query. DDL execute call can contain one DDL statement; bound seed/receipt writes use run. Failure rolls back that file and stops startup without deleting user DB. On web await saveToStore after commit before advancing reported migration state. Re-running is no-op. Do not simultaneously use plugin addUpgradeStatement/user_version as a second migration authority; plugin connection version fixed by adapter, core schema_migrations is authoritative. Full raw restore requires exact ordered version/checksum fingerprint, not evaluating arbitrary uploaded migration SQL.

## Durable SyncState checkpoint v2

```ts
type SetKey = { language: 'en'|'ja'; setId: string };
type Selection = { scope:'all'; sets:[] } | { scope:'followed'; sets:SetKey[] };
type SyncCheckpointV2 = {
  version:2; languages:('en'|'ja')[]; selection:Selection;
  lists:Array<{language:'en'|'ja'; etag:string|null; checkedAt:string;
    setIds:string[]; fetched:boolean}>;
  sets:Array<SetKey & {
    status:'pending'|'running'|'done'|'failed'|'unpublished';
    manifestFetched:boolean; detailEtag:string|null; checkedAt:string|null;
    advertisedTotal:number|null; cardsTotal:number|null; cardsDone:number; cardsFailed:number;
    cards:Array<{id:string; status:'pending'|'done'|'failed'; errorCode:string|null}>;
  }>;
  warnings:Array<{code:string;language:'en'|'ja';cardId:string|null;message:string}>;
};
```

Validate checkpoint/selection JSON, unique language+set keys/card IDs, no NaN/unbounded warning strings. lists cache successful ETags/listing IDs from previous persisted runs for conditional discovery. Missing local list on304 ->unconditional request. Set-list304 says NOTHING about card fields/prices. Manifest stored before cards; successful brief checkpoint and completion atomically persisted with metadata. New run rechecks unpublished shells even304; unpublished has fetched empty manifest, cardsTotal0, excluded from completion denominator. setsDone counts done+unpublished processed units; cardsDone counts successfully processed/fresh-skipped, NOT failed. cardsTotal null until all selected manifests known; sums reconcile to durable per-set counters. Completed only if all chosen units done/unpublished and no failed/pending work. For prices_only use frozen local selected card manifest, no listing/catalog writes. Resume v2 retains selection/done entries; unsupported checkpoint version marks run interrupted/unresumable and offers new run, never guesses. UI gets per-set summarized counters/lastError and max100 warnings, not full card arrays/tokens. Resume/cancel/fencing/foreground limits are in ARCHITECTURE/API.

## Grouped collection view

Binding owner ruling: groupBy:'card' yields one displayed row per (language,cardId,variant), cardId being exact catalog id or custom UUID under explicit source discriminator. variantDetail subgroups stay represented by copy IDs and details; they do not create extra top-level tiles. Return qty of matching copies, all matching copyIds, totalQty/copyIds for whole group, representative newest matching copy, and conditions/grade/variantDetails summaries. Duplicate eligibility is computed on precise (identity,variant,variantDetail) groups across WHOLE collection before filters. Dashboard unique/duplicates retain that precise equation. groupBy:'copy' is paginated individual rows. Apply filters to copies first, group/paginate matching rows; do not page copies then collapse. API defines large copyId list safety.

## Safety invariants

Service write validation is required in addition to checks: reject a partial money pair, out-of-range integer, unknown enum, mismatch language/custom id, malformed JSON, unrecognized parent UUID or more than 100 bulk copies. Grade + members are transactional. Catalog mutation code must not have a collection repository dependency. Tests must delete all catalog_cards and catalog_sets with foreign_keys=ON and still render/export every owned snapshot; attempts to delete referenced identity ledger rows fail. Import may recreate ledger stubs for offline catalog references but may not invent metadata catalog cards. Do not disable foreign_keys for a sync/import/restore.
