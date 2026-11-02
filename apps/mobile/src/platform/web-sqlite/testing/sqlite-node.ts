/** Node-only helper (vitest): loads the sqlite-wasm node build once. Not imported by production code. */
import type { Sqlite3Api } from '../executor';

let cached: Promise<Sqlite3Api> | undefined;

export function loadSqlite3(): Promise<Sqlite3Api> {
  cached ??= import('@sqlite.org/sqlite-wasm').then(async (m) => (await (m.default as unknown as () => Promise<unknown>)()) as Sqlite3Api);
  return cached;
}
