import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { defineCustomElements } from 'jeep-sqlite/loader';

const databaseName = 'flashydex';
let connectionPromise: Promise<SQLiteDBConnection> | undefined;

async function prepareWebComponent(): Promise<void> {
  await defineCustomElements(window);
  await customElements.whenDefined('jeep-sqlite');
  if (!document.querySelector('jeep-sqlite')) {
    document.body.append(document.createElement('jeep-sqlite'));
  }
}

async function openConnection(): Promise<SQLiteDBConnection> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  if (Capacitor.getPlatform() === 'web') {
    await prepareWebComponent();
    await sqlite.initWebStore();
  }

  const connection = await sqlite.createConnection(databaseName, false, 'no-encryption', 1, false);
  await connection.open();
  return connection;
}

export async function getSqliteConnection(): Promise<SQLiteDBConnection> {
  connectionPromise ??= openConnection();
  return connectionPromise;
}

export async function getDrizzleClient() {
  const connection = await getSqliteConnection();
  return drizzle(async (statement, params, method) => {
    if (method === 'run') {
      await connection.run(statement, params);
      return { rows: [] };
    }
    const result = await connection.query(statement, params);
    return { rows: result.values ?? [] };
  });
}

export async function readSqliteVersion(): Promise<string> {
  const connection = await getSqliteConnection();
  const result = await connection.query('select sqlite_version() as version');
  const row = result.values?.[0] as { version?: unknown } | undefined;
  if (typeof row?.version !== 'string') {
    throw new Error('SQLite did not return a version.');
  }
  return row.version;
}
