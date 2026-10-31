import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import localforage from 'localforage';
import { createProxyCallback } from './sqlite-proxy';

/** Logical connection name of the user DB. The plugin turns it into `flashydex-userSQLite.db`. */
export const USER_DB_NAME = 'flashydex-user';

let pluginPromise: Promise<SQLiteConnection> | undefined;
const connections = new Map<string, Promise<SQLiteDBConnection>>();

function isWeb(): boolean {
  return Capacitor.getPlatform() === 'web';
}

/**
 * Web only (capacitor-community/sqlite docs/Web-Usage.md): define the jeep-sqlite custom element,
 * append it to the DOM, await its definition, then `initWebStore()` BEFORE any createConnection.
 * The sql-wasm.wasm file must be served at /assets/sql-wasm.wasm and must match the sql.js
 * generation bundled inside jeep-sqlite (see scripts/copy-sql-wasm.mjs).
 */
async function prepareWebStore(sqlite: SQLiteConnection): Promise<void> {
  const { defineCustomElements } = await import('jeep-sqlite/loader');
  await defineCustomElements(window);
  if (!document.querySelector('jeep-sqlite')) {
    document.body.appendChild(document.createElement('jeep-sqlite'));
  }
  await customElements.whenDefined('jeep-sqlite');
  await sqlite.initWebStore();
}

/** Shared plugin wrapper; performs the web bootstrap exactly once. */
export function getSqlitePlugin(): Promise<SQLiteConnection> {
  pluginPromise ??= (async () => {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    if (isWeb()) await prepareWebStore(sqlite);
    return sqlite;
  })();
  return pluginPromise;
}

/**
 * Opens (creating if needed) a conformed connection by logical name. The plugin appends `SQLite.db`.
 * Connections are cached per name+mode so callers can share them.
 */
export function openLogicalConnection(name: string, readonly = false): Promise<SQLiteDBConnection> {
  const key = `${name}:${readonly ? 'ro' : 'rw'}`;
  let existing = connections.get(key);
  if (!existing) {
    existing = (async () => {
      const sqlite = await getSqlitePlugin();
      const known = (await sqlite.isConnection(name, readonly)).result;
      const connection = known
        ? await sqlite.retrieveConnection(name, readonly)
        : await sqlite.createConnection(name, false, 'no-encryption', 1, readonly);
      await connection.open();
      return connection;
    })();
    existing.catch(() => connections.delete(key));
    connections.set(key, existing);
  }
  return existing;
}

/** Close a cached logical connection (web: persists the in-memory DB to IndexedDB). */
export async function closeLogicalConnection(name: string, readonly = false): Promise<void> {
  const key = `${name}:${readonly ? 'ro' : 'rw'}`;
  const cached = connections.get(key);
  connections.delete(key);
  if (!cached) return;
  const sqlite = await getSqlitePlugin();
  await (await cached).close().catch(() => undefined);
  await sqlite.closeConnection(name, readonly).catch(() => undefined);
}

/** Same IndexedDB store jeep-sqlite uses (jeep-sqlite 2.8.0 utils-store.js: localforage `jeepSqliteStore`/`databases`, key `<name>SQLite.db`). */
const jeepStore = localforage.createInstance({ name: 'jeepSqliteStore', storeName: 'databases', driver: [localforage.INDEXEDDB] });

/**
 * Web only: flush a database from sql.js memory into the IndexedDB store.
 *
 * jeep-sqlite's `saveToStore` is `removeItem(key)` THEN `setItem(key, bytes)` (utils-store.js saveDBToStore), which is not atomic: when the
 * put fails (QuotaExceededError) the persisted database is already DELETED, and the next page load would create an empty one (found by the
 * injected-quota e2e). So the previously persisted bytes are read first and written back if the save throws, then the original error is rethrown
 * (core latches `persistence_failed`). A tab kill between jeep's remove and put is still unprotected without bypassing jeep (see report).
 */
export async function flushWebStore(name: string): Promise<void> {
  if (!isWeb()) return;
  const sqlite = await getSqlitePlugin();
  const key = `${name}SQLite.db`;
  const previous = await jeepStore.getItem<Uint8Array>(key);
  try {
    await sqlite.saveToStore(name);
  } catch (error) {
    if (previous instanceof Uint8Array && previous.length > 0) await jeepStore.setItem(key, previous).catch(() => undefined);
    throw error;
  }
}

export function getSqliteConnection(): Promise<SQLiteDBConnection> {
  return openLogicalConnection(USER_DB_NAME);
}

export async function getDrizzleClient() {
  const connection = await getSqliteConnection();
  return drizzle(createProxyCallback(connection));
}

export async function readSqliteVersion(): Promise<string> {
  const connection = await getSqliteConnection();
  const result = await connection.query('select sqlite_version() as version');
  const row = result.values?.find((value) => typeof (value as { version?: unknown }).version === 'string') as { version?: unknown } | undefined;
  if (typeof row?.version !== 'string') {
    throw new Error('SQLite did not return a version.');
  }
  return row.version;
}
