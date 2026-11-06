import Database from 'better-sqlite3';
import { existsSync, rmSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { CATALOG_SCHEMA_VERSION, catalogCards, catalogLatestPrices, catalogMeta, catalogSets, catalogVariants, schemaMigrations } from '@flashydex/core/catalog-schema';
import {
  mapCard, mapSet, type CatalogCardRow, type CatalogLanguage, type CatalogLatestPriceRow, type CatalogSetRow, type CatalogVariantRow,
  type RawCard, type RawSetDetail
} from '@flashydex/core/catalog/tcgdex';
import { applyCatalogMigrations, schemaFingerprint, type Migration } from './migrations';

export interface PackCounts { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number }

export interface BuildDbInput {
  language: CatalogLanguage;
  version: string;
  builtAt: string;
  cutoffAt: string;
  builderVersion: string;
  details: ReadonlyMap<string, RawSetDetail>;
  selectedSetIds: readonly string[];
  cards: ReadonlyMap<string, RawCard>;
  /** Symbol URLs that returned 404 (nulled). */
  missingAssets: ReadonlySet<string>;
  migrations: readonly Migration[];
}

export interface BuildDbResult { counts: PackCounts; warnings: string[]; fingerprint: string }

const ALLOWED_TABLES = [catalogSets, catalogCards, catalogVariants, catalogLatestPrices, catalogMeta, schemaMigrations].map((t) => getTableConfig(t).name).sort();
/**
 * Pack page size (ADR-055). 64 KiB, not SQLite's 4 KiB default: on the production web path every page is one synchronous
 * OPFS read (~0.3 ms each regardless of size), so page count, not byte count, sets the cost of integrity_check,
 * foreign_key_check and cold searches. Measured on the full EN catalog: validate 36.9 s → 3.5 s, cold table scan 9.3 s → 0.5 s,
 * and the raw file is 12% smaller. Native SQLite handles 64 KiB pages without configuration.
 */
export const CATALOG_PAGE_SIZE = 65536;

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const flag = (value: boolean) => (value ? 1 : 0);

/** Build a fresh single-language pack DB at `partPath` (a `.db.part` file). Deterministic insert order: PK order. */
export function buildCatalogDb(partPath: string, input: BuildDbInput): BuildDbResult {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(partPath + suffix)) rmSync(partPath + suffix);
  const db = new Database(partPath);
  const warnings: string[] = [];
  try {
    db.pragma(`page_size = ${CATALOG_PAGE_SIZE}`); // must precede the first table (ADR-055)
    db.pragma('journal_mode = DELETE');
    db.pragma('foreign_keys = ON');
    applyCatalogMigrations(db, input.migrations, input.builtAt);

    const ctx = { language: input.language, syncedAt: input.cutoffAt };
    const setRows: CatalogSetRow[] = input.selectedSetIds.map((id) => {
      const row = mapSet(input.details.get(id)!, ctx);
      if (row.symbolUrl && input.missingAssets.has(row.symbolUrl)) {
        warnings.push(`set ${id}: symbol ${row.symbolUrl} returned 404 -> symbol_url NULL`);
        row.symbolUrl = null;
      }
      return row;
    }).sort((a, b) => byString(a.id, b.id));

    const cardRows: CatalogCardRow[] = [];
    const variantRows: CatalogVariantRow[] = [];
    const priceRows: CatalogLatestPriceRow[] = [];
    for (const id of [...input.cards.keys()].sort(byString)) {
      const mapped = mapCard(input.cards.get(id)!, ctx);
      cardRows.push(mapped.card);
      variantRows.push(...mapped.variants);
      priceRows.push(...mapped.prices);
      for (const w of mapped.warnings) warnings.push(`${w.code} ${w.cardId ?? ''}: ${w.message}`);
    }
    variantRows.sort((a, b) => byString(a.cardId, b.cardId) || byString(a.variantKey, b.variantKey));
    priceRows.sort((a, b) => byString(a.id, b.id));

    const localKeys = new Set<string>();
    for (const card of cardRows) {
      const key = `${card.setId}\u0000${card.localId}`;
      if (localKeys.has(key)) throw new Error(`Duplicate (set, localId) ${card.setId}/${card.localId} (card ${card.id}) violates cc_set_local`);
      localKeys.add(key);
    }

    const insertSet = db.prepare(`INSERT INTO catalog_sets (language,id,name,name_search,series,status,release_date,official_count,total_count,logo_url,symbol_url,raw_json,synced_at)
      VALUES (@language,@id,@name,@nameSearch,@series,@status,@releaseDate,@officialCount,@totalCount,@logoUrl,@symbolUrl,@rawJson,@syncedAt)`);
    const insertCard = db.prepare(`INSERT INTO catalog_cards (language,id,set_id,local_id,local_id_sort,name,name_search,rarity,category,illustrator,image_url,has_normal,has_holo,has_reverse,has_first_edition,w_promo,available_variants_json,raw_json,synced_at,detail_synced_at)
      VALUES (@language,@id,@setId,@localId,@localIdSort,@name,@nameSearch,@rarity,@category,@illustrator,@imageUrl,@hasNormal,@hasHolo,@hasReverse,@hasFirstEdition,@wPromo,@availableVariantsJson,@rawJson,@syncedAt,@detailSyncedAt)`);
    const insertVariant = db.prepare(`INSERT INTO catalog_variants (language,card_id,variant_key,variant,variant_detail,provider_variant_id,type,subtype,foil,size,stamps_json,attributes_json)
      VALUES (@language,@cardId,@variantKey,@variant,@variantDetail,@providerVariantId,@type,@subtype,@foil,@size,@stampsJson,@attributesJson)`);
    const insertPrice = db.prepare(`INSERT INTO catalog_latest_prices (id,catalog_card_id,language,source,variant,variant_detail,provider_variant_key,currency,low_cents,mid_cents,high_cents,market_cents,trend_cents,source_updated_at,captured_at,observation_key)
      VALUES (@id,@catalogCardId,@language,@source,@variant,@variantDetail,@providerVariantKey,@currency,@lowCents,@midCents,@highCents,@marketCents,@trendCents,@sourceUpdatedAt,@capturedAt,@observationKey)`);

    const counts: PackCounts = {
      sets: setRows.length, cards: cardRows.length, variants: variantRows.length, prices: priceRows.length,
      unpublishedSets: setRows.filter((s) => s.status === 'unpublished').length
    };
    const fingerprint = schemaFingerprint(input.migrations);

    db.transaction(() => {
      for (const row of setRows) insertSet.run(row);
      for (const row of cardRows) insertCard.run({ ...row, hasNormal: flag(row.hasNormal), hasHolo: flag(row.hasHolo), hasReverse: flag(row.hasReverse), hasFirstEdition: flag(row.hasFirstEdition), wPromo: flag(row.wPromo) });
      for (const row of variantRows) insertVariant.run(row);
      for (const row of priceRows) insertPrice.run(row);
      db.prepare(`INSERT INTO catalog_meta (id,language,version,schema_version,built_at,builder_version,source_cutoff_at,source_set_count,source_card_count,source_variant_count,source_price_count,unpublished_set_count,schema_fingerprint)
        VALUES ('catalog',?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.language, input.version, CATALOG_SCHEMA_VERSION, input.builtAt, input.builderVersion, input.cutoffAt,
        counts.sets, counts.cards, counts.variants, counts.prices, counts.unpublishedSets, fingerprint
      );
    })();

    db.pragma('journal_mode = DELETE');
    db.exec('VACUUM');
    return { counts, warnings, fingerprint };
  } finally {
    db.close();
  }
}

export interface VerifyResult { counts: PackCounts; language: string; version: string; schemaVersion: number; journalMode: string; pageSize: number }

/** Independent verification of a closed pack file (also run on the decompressed round-trip copy). */
export function verifyCatalogDb(path: string, expected: { language: CatalogLanguage; version: string; counts: PackCounts; fingerprint: string }): VerifyResult {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== 'ok') throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
    db.pragma('foreign_keys = ON');
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length) throw new Error(`foreign_key_check reported ${fk.length} violation(s)`);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    if (JSON.stringify(tables) !== JSON.stringify(ALLOWED_TABLES)) throw new Error(`Unexpected table set: ${tables.join(', ')}`);
    const extra = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('trigger','view') OR (type='table' AND sql LIKE 'CREATE VIRTUAL%')").all();
    if (extra.length) throw new Error(`Forbidden schema objects: ${JSON.stringify(extra)}`);

    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const counts: PackCounts = {
      sets: count('catalog_sets'), cards: count('catalog_cards'), variants: count('catalog_variants'), prices: count('catalog_latest_prices'),
      unpublishedSets: (db.prepare("SELECT COUNT(*) AS n FROM catalog_sets WHERE status='unpublished'").get() as { n: number }).n
    };
    if (JSON.stringify(counts) !== JSON.stringify(expected.counts)) throw new Error(`Row counts ${JSON.stringify(counts)} != expected ${JSON.stringify(expected.counts)}`);

    for (const table of ['catalog_sets', 'catalog_cards', 'catalog_variants', 'catalog_latest_prices']) {
      const other = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE language <> ?`).get(expected.language) as { n: number }).n;
      if (other) throw new Error(`${table} contains rows of another language`);
    }
    const meta = db.prepare('SELECT * FROM catalog_meta').all() as Array<Record<string, unknown>>;
    if (meta.length !== 1 || meta[0]!.language !== expected.language || meta[0]!.version !== expected.version || meta[0]!.schema_fingerprint !== expected.fingerprint) {
      throw new Error(`catalog_meta mismatch: ${JSON.stringify(meta)}`);
    }
    const journalMode = String(db.pragma('journal_mode', { simple: true }));
    if (journalMode !== 'delete') throw new Error(`journal_mode is ${journalMode}, expected delete`);
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    if (pageSize !== CATALOG_PAGE_SIZE) throw new Error(`page_size is ${pageSize}, expected ${CATALOG_PAGE_SIZE}`);
    return {
      counts, language: String(meta[0]!.language), version: String(meta[0]!.version), schemaVersion: Number(meta[0]!.schema_version),
      journalMode, pageSize
    };
  } finally {
    db.close();
  }
}
