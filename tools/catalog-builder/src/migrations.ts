import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export interface Migration {
  /** File name without `.sql`, e.g. `0000_initial` (stored in schema_migrations.version). */
  version: string;
  /** Lowercase SHA-256 of the .sql bytes with CRLF normalised to LF. */
  checksum: string;
  statements: string[];
}

export const DEFAULT_CATALOG_MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/core/migrations/catalog/', import.meta.url));

const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

/** CRLF -> LF so a Windows checkout (autocrlf) and a Linux CI checkout hash identically. */
export function normalizeSqlText(text: string): string {
  return text.split(CRLF).join(LF);
}

/** Statements are split ONLY on drizzle-kit's `--> statement-breakpoint` markers (never on semicolons). */
export function loadCatalogMigrations(dir = process.env.CATALOG_MIGRATIONS_DIR ?? DEFAULT_CATALOG_MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No catalog migration files in ${dir}`);
  return files.map((file) => {
    const text = normalizeSqlText(readFileSync(join(dir, file), 'utf8'));
    return {
      version: file.replace(/\.sql$/, ''),
      checksum: createHash('sha256').update(text, 'utf8').digest('hex'),
      statements: text.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
    };
  });
}

/** Fingerprint of the exact bundled chain: SHA-256 over `version:checksum` lines. Stored in catalog_meta. */
export function schemaFingerprint(migrations: readonly Migration[]): string {
  return createHash('sha256').update(migrations.map((m) => `${m.version}:${m.checksum}${LF}`).join('')).digest('hex');
}

/**
 * Minimal migration applier for the builder: each file's statements and its receipt row run in ONE transaction;
 * foreign keys stay ON. A DB that already has receipts must match the bundled prefix by checksum.
 */
export function applyCatalogMigrations(db: Database.Database, migrations: readonly Migration[], appliedAt: string): void {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() !== undefined;
  const applied = new Map<string, string>();
  if (hasTable) for (const row of db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: string; checksum: string }>) applied.set(row.version, row.checksum);
  for (const [version, checksum] of applied) {
    const bundled = migrations.find((m) => m.version === version);
    if (!bundled || bundled.checksum !== checksum) throw new Error(`Applied catalog migration ${version} does not match the bundled SQL (checksum drift)`);
  }
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.checksum, appliedAt);
    })();
  }
}
