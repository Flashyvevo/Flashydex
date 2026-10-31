/**
 * USER database schema (flashydex-user.db), docs/DATA-MODEL.md "Drizzle base entity declarations" + "A3 schema additions".
 * The SQL in packages/core/migrations/user/ is generated from this file by drizzle-kit (`npm run db:generate`);
 * test/user-schema.test.ts asserts the applied chain matches these declarations.
 *
 * No catalog metadata tables live here. Only owned_cards and price_snapshots reference catalog_identities (the personal
 * reference ledger). No FK / trigger / ON DELETE action crosses a file boundary.
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const LANGUAGES = ['en', 'ja'] as const;
export const VARIANTS = ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped', 'shadowless', 'other'] as const;
export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export const GRADING_COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'other'] as const;
export const SYNC_STATUSES = ['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
/** User chain schema generation (bump with a new migration file). */
export const USER_SCHEMA_VERSION = 1;

const id = () => text('id').notNull().primaryKey();
const created = () => text('created_at').notNull();
const updated = () => text('updated_at').notNull();

export const catalogIdentities = sqliteTable(
  'catalog_identities',
  {
    language: text('language', { enum: LANGUAGES }).notNull(),
    id: text('id').notNull(),
    createdAt: created()
  },
  (t) => [primaryKey({ columns: [t.language, t.id] }), check('ci_language', sql`${t.language} IN ('en','ja')`)]
);

export const customCards = sqliteTable(
  'custom_cards',
  {
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
    updatedAt: updated()
  },
  (t) => [index('custom_name').on(t.nameSearch, t.id), check('custom_language', sql`${t.language} IN ('en','ja')`)]
);

export const acquisitions = sqliteTable(
  'acquisitions',
  {
    id: id(),
    purchasedOn: text('purchased_on'),
    source: text('source'),
    notes: text('notes'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [index('acq_date').on(t.purchasedOn, t.id)]
);

export const storageLocations = sqliteTable(
  'storage_locations',
  {
    id: id(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    description: text('description'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [uniqueIndex('storage_name_key').on(t.nameKey)]
);

export const collectionGroups = sqliteTable(
  'collection_groups',
  {
    id: id(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    description: text('description'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [uniqueIndex('group_name_key').on(t.nameKey)]
);

export const scanSessions = sqliteTable(
  'scan_sessions',
  {
    id: id(),
    status: text('status', { enum: ['open', 'closed', 'abandoned'] }).notNull().default('open'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    notes: text('notes')
  },
  (t) => [
    index('scan_started').on(t.startedAt, t.id),
    check('scan_status', sql`${t.status} IN ('open','closed','abandoned')`),
    check('scan_closed_at', sql`(${t.status} = 'open' AND ${t.endedAt} IS NULL)
    OR (${t.status} <> 'open' AND ${t.endedAt} IS NOT NULL)`)
  ]
);

export const ownedCards = sqliteTable(
  'owned_cards',
  {
    id: id(),
    catalogCardId: text('catalog_card_id'),
    customCardId: text('custom_card_id').references(() => customCards.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
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
    updatedAt: updated()
  },
  (t) => [
    foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
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
      AND ${t.manualPriceCents} BETWEEN 0 AND 2147483647 AND ${t.manualPriceCurrency} IN ('USD','EUR'))`)
  ]
);

export const grades = sqliteTable(
  'grades',
  {
    id: id(),
    ownedCardId: text('owned_card_id').notNull().references(() => ownedCards.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    company: text('company', { enum: GRADING_COMPANIES }).notNull(),
    companyLabel: text('company_label'),
    grade: text('grade').notNull(),
    certNumber: text('cert_number'),
    notes: text('notes'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [
    uniqueIndex('grade_copy').on(t.ownedCardId),
    index('grade_company').on(t.company),
    index('grade_cert').on(t.company, t.certNumber),
    check('grade_company_valid', sql`${t.company} IN ('PSA','BGS','CGC','SGC','ACE','TAG','other')`),
    check('grade_other_label', sql`${t.company} <> 'other' OR (${t.companyLabel} IS NOT NULL AND length(trim(${t.companyLabel})) > 0)`)
  ]
);

export const collectionGroupMembers = sqliteTable(
  'collection_group_members',
  {
    collectionGroupId: text('collection_group_id').notNull().references(() => collectionGroups.id, { onDelete: 'cascade', onUpdate: 'restrict' }),
    ownedCardId: text('owned_card_id').notNull().references(() => ownedCards.id, { onDelete: 'cascade', onUpdate: 'restrict' })
  },
  (t) => [primaryKey({ columns: [t.collectionGroupId, t.ownedCardId] }), index('member_copy').on(t.ownedCardId)]
);

export const priceSnapshots = sqliteTable(
  'price_snapshots',
  {
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
    observationKey: text('observation_key').notNull()
  },
  (t) => [
    foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
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
    check('price_trend', sql`${t.trendCents} IS NULL OR ${t.trendCents} BETWEEN 0 AND 2147483647`)
  ]
);

export const catalogAnnotations = sqliteTable(
  'catalog_annotations',
  {
    language: text('language', { enum: LANGUAGES }).notNull(),
    catalogCardId: text('catalog_card_id').notNull(),
    displayOverridesJson: text('display_overrides_json').notNull(),
    notes: text('notes'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [
    primaryKey({ columns: [t.language, t.catalogCardId] }),
    foreignKey({ columns: [t.language, t.catalogCardId], foreignColumns: [catalogIdentities.language, catalogIdentities.id] })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('ca_language', sql`${t.language} IN ('en','ja')`)
  ]
);

export const syncState = sqliteTable(
  'sync_state',
  {
    id: id(),
    status: text('status', { enum: SYNC_STATUSES }).notNull().default('queued'),
    mode: text('mode', { enum: ['incremental', 'refresh', 'prices_only'] }).notNull().default('incremental'),
    languagesJson: text('languages_json').notNull(),
    selectionJson: text('selection_json').notNull(),
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
    updatedAt: updated()
  },
  (t) => [
    uniqueIndex('sync_lock').on(t.lockKey),
    index('sync_created').on(t.createdAt, t.id),
    check('sync_status', sql`${t.status} IN ('queued','running','cancel_requested','completed','failed','cancelled','interrupted')`),
    check('sync_mode', sql`${t.mode} IN ('incremental','refresh','prices_only')`),
    check('sync_lock_value', sql`${t.lockKey} IS NULL OR ${t.lockKey} = 'catalog'`),
    check('sync_counts', sql`${t.attempt} >= 1 AND ${t.setsDone} >= 0 AND ${t.cardsDone} >= 0 AND ${t.cardsFailed} >= 0
    AND (${t.setsTotal} IS NULL OR ${t.setsTotal} >= ${t.setsDone})
    AND (${t.cardsTotal} IS NULL OR ${t.cardsTotal} >= ${t.cardsDone} + ${t.cardsFailed})`)
  ]
);

export const dataOperationReceipts = sqliteTable(
  'data_operation_receipts',
  {
    id: id(),
    operation: text('operation', { enum: ['import'] }).notNull(),
    planHash: text('plan_hash').notNull(),
    resultJson: text('result_json').notNull(),
    committedAt: text('committed_at').notNull(),
    expiresAt: text('expires_at').notNull()
  },
  (t) => [index('receipt_expiry').on(t.expiresAt), check('receipt_operation', sql`${t.operation} = 'import'`)]
);

export const appState = sqliteTable(
  'app_state',
  {
    id: id(),
    collectionRevision: integer('collection_revision').notNull().default(0),
    updatedAt: updated()
  },
  (t) => [check('app_singleton', sql`${t.id} = 'collection'`), check('app_revision', sql`${t.collectionRevision} >= 0`)]
);

export const appSettings = sqliteTable(
  'app_settings',
  {
    id: id(),
    languagesJson: text('languages_json').notNull().default('["en","ja"]'),
    setsFollowedJson: text('sets_followed_json').notNull().default('[]'),
    syncAllSets: integer('sync_all_sets', { mode: 'boolean' }).notNull().default(false),
    hideTcgPocket: integer('hide_tcg_pocket', { mode: 'boolean' }).notNull().default(true),
    defaultCurrency: text('default_currency', { enum: ['USD', 'EUR'] }).notNull().default('USD'),
    disclaimerAcknowledged: integer('disclaimer_acknowledged', { mode: 'boolean' }).notNull().default(false),
    disclaimerAcknowledgedAt: text('disclaimer_acknowledged_at'),
    onboardingCompletedAt: text('onboarding_completed_at'),
    updatedAt: updated()
  },
  (t) => [
    check('settings_singleton', sql`${t.id} = 'app'`),
    check('settings_currency', sql`${t.defaultCurrency} IN ('USD','EUR')`),
    check('settings_booleans', sql`${t.syncAllSets} IN (0,1) AND ${t.hideTcgPocket} IN (0,1)
    AND ${t.disclaimerAcknowledged} IN (0,1)`),
    check('settings_disclaimer', sql`(${t.disclaimerAcknowledged} = 0 AND ${t.disclaimerAcknowledgedAt} IS NULL)
    OR (${t.disclaimerAcknowledged} = 1 AND ${t.disclaimerAcknowledgedAt} IS NOT NULL)`)
  ]
);

export const installedCatalogs = sqliteTable(
  'installed_catalogs',
  {
    language: text('language', { enum: LANGUAGES }).primaryKey().notNull(),
    version: text('version'),
    sha256: text('sha256'),
    installedAt: text('installed_at'),
    status: text('status', { enum: ['absent', 'installed', 'failed'] }).notNull(),
    schemaVersion: integer('schema_version'),
    generation: integer('generation').notNull().default(0),
    activeRef: text('active_ref')
  },
  (t) => [
    check('ic_language', sql`${t.language} IN ('en','ja')`),
    check('ic_generation', sql`${t.generation} >= 0`),
    check('ic_status_shape', sql`(${t.status} = 'absent' AND ${t.version} IS NULL AND ${t.sha256} IS NULL AND ${t.installedAt} IS NULL AND ${t.activeRef} IS NULL AND ${t.schemaVersion} IS NULL)
    OR (${t.status} IN ('installed','failed') AND ${t.version} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.installedAt} IS NOT NULL AND ${t.activeRef} IS NOT NULL AND ${t.schemaVersion} >= 1)`)
  ]
);

export const catalogInstallJobs = sqliteTable(
  'catalog_install_jobs',
  {
    id: id(),
    language: text('language', { enum: LANGUAGES }).notNull(),
    state: text('state', {
      enum: [
        'checking', 'downloading', 'downloaded', 'size_checked', 'decompressing', 'verifying', 'validating', 'prepared', 'activating',
        'validating_active', 'committed', 'installed', 'cancelled', 'failed', 'interrupted', 'rolling_back'
      ]
    }).notNull(),
    lockKey: text('lock_key').unique(),
    token: text('token').notNull(),
    manifestEntryJson: text('manifest_entry_json').notNull(),
    compressedBytesDone: integer('compressed_bytes_done').notNull().default(0),
    decompressedBytesDone: integer('decompressed_bytes_done').notNull().default(0),
    etag: text('etag'),
    progressJson: text('progress_json').notNull(),
    journalJson: text('journal_json').notNull(),
    lastErrorJson: text('last_error_json'),
    createdAt: created(),
    updatedAt: updated()
  },
  (t) => [
    index('install_language_created').on(t.language, t.createdAt, t.id),
    check('cij_language', sql`${t.language} IN ('en','ja')`),
    check('cij_state', sql`${t.state} IN ('checking','downloading','downloaded','size_checked','decompressing','verifying','validating','prepared','activating','validating_active','committed','installed','cancelled','failed','interrupted','rolling_back')`),
    check('cij_lock', sql`${t.lockKey} IS NULL OR ${t.lockKey} = 'catalog-install'`),
    check('cij_bytes', sql`${t.compressedBytesDone} >= 0 AND ${t.decompressedBytesDone} >= 0`)
  ]
);

export const packMetrics = sqliteTable(
  'pack_metrics',
  {
    id: id(),
    language: text('language', { enum: LANGUAGES }).notNull(),
    version: text('version').notNull(),
    operationId: text('operation_id').notNull(),
    metricsJson: text('metrics_json').notNull(),
    recordedAt: text('recorded_at').notNull()
  },
  (t) => [index('metrics_operation').on(t.operationId, t.id), check('pm_language', sql`${t.language} IN ('en','ja')`)]
);

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: text('version').notNull().primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: text('applied_at').notNull()
});

/** D45: one durable admission row for install / uninstall / rollback / sync / restore (single PK value 'lock'). */
export const workAdmission = sqliteTable(
  'work_admission',
  {
    id: id(),
    kind: text('kind', { enum: ['install', 'uninstall', 'rollback', 'sync', 'restore'] }).notNull(),
    token: text('token').notNull(),
    languagesJson: text('languages_json').notNull(),
    acquiredAt: text('acquired_at').notNull()
  },
  (t) => [
    check('wa_single', sql`${t.id} = 'lock'`),
    check('wa_kind', sql`${t.kind} IN ('install','uninstall','rollback','sync','restore')`)
  ]
);

/** D40: .fdx restore receipts (operational; never exported or restored). */
export const restoreReceipts = sqliteTable(
  'restore_receipts',
  {
    id: id(),
    backupHash: text('backup_hash').notNull(),
    resultJson: text('result_json').notNull(),
    restoredAt: text('restored_at').notNull(),
    expiresAt: text('expires_at').notNull()
  },
  (t) => [index('restore_receipt_expiry').on(t.expiresAt)]
);
