import { CATALOG_SCHEMA_OBJECTS, CATALOG_SCHEMA_FINGERPRINT } from '../db/catalog-fingerprint.generated';
import { CATALOG_SCHEMA_VERSION } from '../db/catalog-schema';
import { CATALOG_MIGRATIONS } from '../db/migrations.generated';
import { migrationChecksum } from '../db/migrator';
import { sha256Hex } from '../catalog/sha256';
import type { SqlDriver } from '../db/sql';
import { CatalogError } from '../errors';

export { CATALOG_SCHEMA_FINGERPRINT };

/** The bundled catalog chain as receipts: `version` + SHA-256 of the CRLF-normalised .sql (the same value the migrator and the builder write). */
const BUNDLED_RECEIPTS: readonly { version: string; checksum: string }[] = [...CATALOG_MIGRATIONS]
  .sort((a, b) => a.version.localeCompare(b.version))
  .map((file) => ({ version: file.version, checksum: migrationChecksum(file) }));

/**
 * Fingerprint of the exact bundled catalog chain, ported 1:1 from tools/catalog-builder/src/migrations.ts `schemaFingerprint`:
 * SHA-256 over `version:checksum\n` lines. This is the value the builder stores in `catalog_meta.schema_fingerprint`
 * (NOT `CATALOG_SCHEMA_FINGERPRINT`, which hashes the sqlite_master object list).
 */
export const CATALOG_CHAIN_FINGERPRINT: string = sha256Hex(BUNDLED_RECEIPTS.map((m) => `${m.version}:${m.checksum}\n`).join(''));

export interface CatalogCounts { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number }

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
const bad = (message: string): CatalogError => new CatalogError('PACK_INVALID', message);

async function rows(driver: SqlDriver, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  try {
    const { rows: out } = await driver.proxy(sql, params, 'values');
    return (out ?? []) as unknown[][];
  } catch {
    // Transport / engine errors while validating are FAILURES, never "best effort".
    throw bad('The catalog file could not be validated');
  }
}

/** Object allowlist + exact normalized SQL against the objects the bundled catalog migrations produce. */
export async function checkSchema(driver: SqlDriver): Promise<void> {
  const found = await rows(driver, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name");
  const expected = new Map(CATALOG_SCHEMA_OBJECTS.map((o) => [`${o.type}\u0000${o.name}`, o]));
  const seen = new Set<string>();
  for (const row of found) {
    const type = String(row[0]);
    const name = String(row[1]);
    if (type === 'trigger') throw bad('The catalog contains a trigger');
    if (type === 'view') throw bad('The catalog contains a view');
    const want = expected.get(`${type}\u0000${name}`);
    if (!want) throw bad(`The catalog contains an unexpected ${type}`);
    if (String(row[2]) !== want.table || (row[3] === null ? null : normalize(String(row[3]))) !== want.sql) throw bad(`The catalog ${type} ${name} does not match this app's schema`);
    seen.add(`${type}\u0000${name}`);
  }
  for (const key of expected.keys()) if (!seen.has(key)) throw bad('The catalog schema is incomplete');
}

/** catalog_meta: exactly one row; language/version/schema must match what was expected. Then the migration receipts + chain fingerprint (S5-09). */
export async function checkMeta(driver: SqlDriver, expected: { language: string; version: string }): Promise<{ schemaVersion: number }> {
  const meta = await rows(driver, 'SELECT language, version, schema_version, schema_fingerprint FROM catalog_meta');
  if (meta.length !== 1) throw bad('catalog_meta is missing or duplicated');
  const [language, version, schema, fingerprint] = meta[0] as [unknown, unknown, unknown, unknown];
  if (language !== expected.language || version !== expected.version) throw bad('catalog_meta does not match the manifest');
  const schemaVersion = Number(schema);
  if (schemaVersion > CATALOG_SCHEMA_VERSION) throw new CatalogError('APP_UPDATE_REQUIRED', 'Catalog schema is newer than this app supports');
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) throw bad('Catalog schema version is not supported');
  await checkReceipts(driver);
  if (fingerprint !== CATALOG_CHAIN_FINGERPRINT) throw bad('The catalog schema fingerprint does not match this app');
  return { schemaVersion };
}

/**
 * S5-09: the VALUES of `schema_migrations` (version + checksum, in order) must equal the bundled catalog chain exactly. A receipt chain that
 * extends the bundled one with the bundled prefix intact was built by a newer app -> APP_UPDATE_REQUIRED; anything else -> PACK_INVALID.
 */
export async function checkReceipts(driver: SqlDriver): Promise<void> {
  const found = await rows(driver, 'SELECT version, checksum FROM schema_migrations ORDER BY version');
  const bundled = BUNDLED_RECEIPTS;
  const prefixMatches = bundled.every((want, i) => found[i] !== undefined && String(found[i]![0]) === want.version && String(found[i]![1]) === want.checksum);
  if (!prefixMatches) throw bad('The catalog migration receipts do not match this app');
  if (found.length > bundled.length) throw new CatalogError('APP_UPDATE_REQUIRED', 'Catalog schema is newer than this app supports');
}

export async function readCounts(driver: SqlDriver): Promise<CatalogCounts> {
  const one = async (sql: string) => Number((await rows(driver, sql))[0]?.[0]);
  return {
    sets: await one('SELECT COUNT(*) FROM catalog_sets'),
    cards: await one('SELECT COUNT(*) FROM catalog_cards'),
    variants: await one('SELECT COUNT(*) FROM catalog_variants'),
    prices: await one('SELECT COUNT(*) FROM catalog_latest_prices'),
    unpublishedSets: await one("SELECT COUNT(*) FROM catalog_sets WHERE status = 'unpublished'")
  };
}

/** Full candidate validation (R09): schema + meta + integrity_check + foreign_key_check + foreign-language rows + manifest counts. */
export async function validateCatalogCandidate(driver: SqlDriver, entry: { language: string; targetVersion: string; counts: CatalogCounts }): Promise<CatalogCounts> {
  await checkSchema(driver);
  await checkMeta(driver, { language: entry.language, version: entry.targetVersion });
  const integrity = await rows(driver, 'PRAGMA integrity_check');
  if (integrity.length !== 1 || integrity[0]?.[0] !== 'ok') throw bad('The catalog failed its integrity check');
  const fk = await rows(driver, 'PRAGMA foreign_key_check');
  if (fk.length > 0) throw bad('The catalog has foreign key violations');
  for (const table of ['catalog_sets', 'catalog_cards', 'catalog_variants', 'catalog_latest_prices']) {
    const foreign = Number((await rows(driver, `SELECT COUNT(*) FROM ${table} WHERE language <> ?`, [entry.language]))[0]?.[0]);
    if (foreign !== 0) throw bad('The catalog contains rows of another language');
  }
  const counts = await readCounts(driver);
  for (const key of Object.keys(counts) as Array<keyof CatalogCounts>) {
    if (counts[key] !== entry.counts[key]) throw bad(`Catalog ${key} count ${counts[key]} does not match the manifest (${entry.counts[key]})`);
  }
  return counts;
}

/** Cheap active-file check for boot recovery: schema + meta only (no full rehash, no counts: sync/refresh legitimately change them). */
export async function validateActiveCatalog(driver: SqlDriver, expected: { language: string; version: string }): Promise<void> {
  await checkSchema(driver);
  await checkMeta(driver, expected);
}
