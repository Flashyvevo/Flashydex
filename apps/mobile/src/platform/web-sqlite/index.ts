/**
 * Public surface of the browser SQLite adapter (Stage F, builder A). Consumers: `platform/app-database.ts` (builder B) and bootstrap.
 *   getWebSqliteClient() -> WebSqliteClient (singleton)     ensureUserDatabase({client, roles, onProgress}) -> UserDbOutcome
 */
export { createWebSqliteClient, getWebSqliteClient, type ClosePathOptions, type WebSqliteClientInternal, type WebSqliteClientOptions } from './client';
export { createEnsureUserDatabase, ensureUserDatabase, MigrationBlockedError, readLegacyUserBytes, type MigrationBlockedReason } from './legacy-migration';
