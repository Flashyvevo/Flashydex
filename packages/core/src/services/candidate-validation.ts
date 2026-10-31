import { CATALOG_SCHEMA_OBJECTS, CATALOG_SCHEMA_FINGERPRINT } from '../db/catalog-fingerprint.generated';
import { CATALOG_SCHEMA_VERSION } from '../db/catalog-schema';
import type { SqlDriver } from '../db/sql';
import { CatalogError } from '../errors';

export { CATALOG_SCHEMA_FINGERPRINT };

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

/** catalog_meta: exactly one row; language/version/schema must match what was expected. */
export async function checkMeta(driver: SqlDriver, expected: { language: string; version: string }): Promise<{ schemaVersion: number }> {
  const meta = await rows(driver, 'SELECT language, version, schema_version FROM catalog_meta');
  if (meta.length !== 1) throw bad('catalog_meta is missing or duplicated');
  const [language, version, schema] = meta[0] as [unknown, unknown, unknown];
  if (language !== expected.language || version !== expected.version) throw bad('catalog_meta does not match the manifest');
  const schemaVersion = Number(schema);
  if (schemaVersion > CATALOG_SCHEMA_VERSION) throw new CatalogError('APP_UPDATE_REQUIRED', 'Catalog schema is newer than this app supports');
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) throw bad('Catalog schema version is not supported');
  return { schemaVersion };
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
