import type { SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { CatalogReadOnlyHandle } from '@flashydex/core';

/** Read-only catalog handle: the generic query/close surface plus the real driver connection (for drizzle sqlite-proxy). */
export interface CatalogHandle extends CatalogReadOnlyHandle {
  readonly connection: SQLiteDBConnection;
}
