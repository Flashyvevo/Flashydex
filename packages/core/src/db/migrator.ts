import { sha256Hex } from '../catalog/sha256';
import { StorageError } from '../errors';
import type { Db } from './sql';

export type MigrationFile = { readonly version: string; readonly sql: string };

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** drizzle-kit statement-breakpoint splitting. Never splits on `;`. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export const migrationChecksum = (file: MigrationFile): string => sha256Hex(file.sql);

/**
 * Apply one migration chain to one database. Each file is atomic (statements + `schema_migrations` row in one transaction,
 * foreign keys stay ON). The applied prefix must match the bundled chain by order and SHA-256; drift or a newer database
 * than this app stops before any write (StorageError MIGRATION_FAILED). Idempotent.
 */
export async function migrate(db: Db, chain: readonly MigrationFile[], now: () => string): Promise<MigrationResult> {
  const files = [...chain].sort((a, b) => a.version.localeCompare(b.version));
  const tableExists = (await db.scalar<number>("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")) === 1;
  const applied = tableExists
    ? (await db.rows('SELECT version, checksum FROM schema_migrations ORDER BY version ASC')).map((row) => ({ version: String(row[0]), checksum: String(row[1]) }))
    : [];

  if (applied.length > files.length) {
    throw new StorageError('MIGRATION_FAILED', 'This database was created by a newer version of the app', { applied: applied.length, known: files.length });
  }
  for (const [index, row] of applied.entries()) {
    const file = files[index];
    if (!file || file.version !== row.version) {
      throw new StorageError('MIGRATION_FAILED', 'The applied migration history does not match this app', { version: row.version });
    }
    if (migrationChecksum(file) !== row.checksum) {
      throw new StorageError('MIGRATION_FAILED', `Migration ${row.version} was modified after it was applied`, { version: row.version });
    }
  }

  const result: MigrationResult = { applied: [], alreadyApplied: applied.map((row) => row.version) };
  for (const file of files.slice(applied.length)) {
    try {
      await db.transaction(async (tx) => {
        for (const statement of splitStatements(file.sql)) await tx.run(statement);
        await tx.run('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)', [file.version, migrationChecksum(file), now()]);
      });
    } catch (error) {
      throw new StorageError('MIGRATION_FAILED', `Migration ${file.version} failed and was rolled back`, {
        version: file.version,
        cause: error instanceof Error ? error.name : 'unknown'
      });
    }
    result.applied.push(file.version);
  }
  return result;
}
