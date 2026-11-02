/**
 * Test/harness helper: builds a legacy-shaped USER database (REAL core migrations, multilingual rows, null/0/leading-zero values, stale
 * jeep catalog receipts) through any `SqlDriver`, and produces a canonical dump of every personal table for byte-for-byte comparison.
 * Used by vitest (in-memory) and by the browser harness (real worker). Never imported by production code.
 */
import { Db, USER_MIGRATIONS, migrate, type SqlDriver } from '@flashydex/core';

const NOW = '2026-10-01T12:00:00.000Z';
export const OPERATIONAL = new Set(['installed_catalogs', 'catalog_install_jobs', 'pack_metrics', 'schema_migrations', 'work_admission', 'restore_receipts', 'sync_state', 'data_operation_receipts']);

export const STALE_JEEP_REF = 'jeep:flashydex-catalog-enSQLite.db';

export async function seedLegacyUser(driver: SqlDriver, options: { extraOwned?: number } = {}): Promise<void> {
  const db = new Db(driver);
  await db.initialize();
  await migrate(db, USER_MIGRATIONS, () => NOW);
  await db.transaction(async (tx) => {
    await tx.run("INSERT INTO catalog_identities (language, id, created_at) VALUES ('en','sv1-001',?), ('ja','sv1-007',?)", [NOW, NOW]);
    await tx.run(
      "INSERT INTO custom_cards (id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, notes, created_at, updated_at) VALUES ('cc-1', 'カスタム ピカチュウ', 'かすたむ ぴかちゅう', NULL, NULL, '000', 'ja', NULL, NULL, '', ?, ?)",
      [NOW, NOW]
    );
    await tx.run("INSERT INTO acquisitions (id, purchased_on, source, notes, created_at, updated_at) VALUES ('acq-1', NULL, 'Café ☕ Münster', '', ?, ?)", [NOW, NOW]);
    await tx.run("INSERT INTO storage_locations (id, name, name_key, description, created_at, updated_at) VALUES ('loc-1', 'Binder ① 日本', 'binder ① 日本', NULL, ?, ?)", [NOW, NOW]);
    await tx.run("INSERT INTO collection_groups (id, name, name_key, description, created_at, updated_at) VALUES ('grp-1', 'Favoritos ★', 'favoritos ★', '', ?, ?)", [NOW, NOW]);
    await tx.run("INSERT INTO scan_sessions (id, status, started_at, ended_at, notes) VALUES ('scan-1', 'closed', ?, ?, NULL)", [NOW, NOW]);
    await tx.run(
      `INSERT INTO owned_cards (id, catalog_card_id, custom_card_id, name, name_search, set_id, set_name, local_id, language, rarity, variant, variant_detail, condition, acquisition_id,
         purchase_price_cents, purchase_currency, storage_location_id, scan_session_id, notes, manual_price_cents, manual_price_currency, created_at, updated_at)
       VALUES ('own-1', 'sv1-001', NULL, 'Sprigatito', 'sprigatito', 'sv1', 'Scarlet & Violet', '001', 'en', NULL, 'normal', '', 'NM', 'acq-1', 0, 'USD', 'loc-1', 'scan-1', NULL, NULL, NULL, ?, ?),
              ('own-2', NULL, 'cc-1', 'カスタム ピカチュウ', 'かすたむ ぴかちゅう', NULL, NULL, '000', 'ja', NULL, 'other', 'ファンアート', NULL, NULL, NULL, NULL, NULL, NULL, '', 1250, 'EUR', ?, ?),
              ('own-3', 'sv1-007', NULL, 'ニャオハ', 'にゃおは', 'sv1', 'スカーレットex', '007', 'ja', 'C', 'holo', '', 'LP', NULL, 199, 'EUR', NULL, NULL, 'ノート', NULL, NULL, ?, ?)`,
      [NOW, NOW, NOW, NOW, NOW, NOW]
    );
    await tx.run("INSERT INTO grades (id, owned_card_id, company, company_label, grade, cert_number, notes, created_at, updated_at) VALUES ('gr-1', 'own-1', 'PSA', NULL, '10', '0012345678', NULL, ?, ?)", [NOW, NOW]);
    await tx.run("INSERT INTO collection_group_members (collection_group_id, owned_card_id) VALUES ('grp-1', 'own-1'), ('grp-1', 'own-3')");
    await tx.run(
      `INSERT INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents, high_cents, market_cents, trend_cents,
         source_updated_at, captured_at, observation_key) VALUES ('ps-1', 'sv1-001', 'en', 'tcgplayer', 'normal', '', 'normal', 'USD', 0, NULL, 500, 0, NULL, NULL, ?, 'obs-1')`,
      [NOW]
    );
    await tx.run("INSERT INTO catalog_annotations (language, catalog_card_id, display_overrides_json, notes, created_at, updated_at) VALUES ('en', 'sv1-001', '{}', 'nota', ?, ?)", [NOW, NOW]);
    await tx.run("UPDATE app_settings SET languages_json = '[\"ja\",\"en\"]', default_currency = 'EUR', disclaimer_acknowledged = 1, disclaimer_acknowledged_at = ?, onboarding_completed_at = ? WHERE id = 'app'", [NOW, NOW]);
    await tx.run("UPDATE app_state SET collection_revision = 7 WHERE id = 'collection'");
    for (let i = 0; i < (options.extraOwned ?? 0); i += 1) {
      await tx.run(
        "INSERT INTO owned_cards (id, custom_card_id, name, name_search, local_id, language, variant, variant_detail, created_at, updated_at) VALUES (?, 'cc-1', ?, ?, ?, 'ja', 'normal', '', ?, ?)",
        [`bulk-${i}`, `カード ${i}`, `かーど ${i}`, String(i).padStart(4, '0'), NOW, NOW]
      );
    }
    // stale jeep-era operational state that must NOT be treated as OPFS files after migration
    await tx.run(
      "INSERT OR REPLACE INTO installed_catalogs (language, version, sha256, installed_at, status, schema_version, generation, active_ref) VALUES ('en', '2026.10.1', ?, ?, 'installed', 1, 3, ?)",
      ['a'.repeat(64), NOW, STALE_JEEP_REF]
    );
    await tx.run(
      "INSERT INTO catalog_install_jobs (id, language, state, lock_key, token, manifest_entry_json, compressed_bytes_done, decompressed_bytes_done, progress_json, journal_json, created_at, updated_at) VALUES ('job-1', 'ja', 'downloading', 'catalog-install', 't', '{}', 5, 0, '{}', '{}', ?, ?)",
      [NOW, NOW]
    );
    await tx.run(
      "INSERT INTO sync_state (id, status, mode, languages_json, selection_json, lock_key, worker_token, created_at, updated_at) VALUES ('sync-1', 'running', 'incremental', '[\"en\"]', '{}', 'catalog', 'w', ?, ?)",
      [NOW, NOW]
    );
    await tx.run("INSERT INTO work_admission (id, kind, token, languages_json, acquired_at) VALUES ('lock', 'sync', 't', '[\"en\"]', ?)", [NOW]);
  });
}

/** Canonical, order-stable dump of every personal (non-operational) table: `{table: [[col, ...], ...]}` as JSON strings. */
export async function dumpPersonal(driver: SqlDriver): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const tables = ((await driver.proxy("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", [], 'values')).rows as unknown[][]).map((r) => String(r[0]));
  for (const name of tables) {
    if (OPERATIONAL.has(name)) continue;
    const rows = (await driver.proxy(`SELECT * FROM "${name}" ORDER BY rowid`, [], 'values')).rows as unknown[][];
    out[name] = rows.map((r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Array.from(v) : v)));
  }
  return out;
}

export async function operationalSnapshot(driver: SqlDriver): Promise<Record<string, unknown[][]>> {
  const q = async (sql: string) => (await driver.proxy(sql, [], 'values')).rows as unknown[][];
  return {
    installed: await q('SELECT language, status, version, sha256, installed_at, schema_version, active_ref FROM installed_catalogs ORDER BY language'),
    jobs: await q('SELECT id, state, lock_key FROM catalog_install_jobs ORDER BY id'),
    sync: await q('SELECT id, status, lock_key FROM sync_state ORDER BY id'),
    admission: await q('SELECT id FROM work_admission')
  };
}
