import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { sql } from 'drizzle-orm';
import { expect, test } from 'vitest';

test('executes real SQLite statements through the Drizzle sqlite-proxy adapter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flashydex-core-'));
  const sqlite = new Database(join(directory, 'flashydex.db'));
  try {
    const db = drizzle(async (statement, params, method) => {
      const prepared = sqlite.prepare(statement);
      if (method === 'run') {
        prepared.run(...params);
        return { rows: [] };
      }
      if (method === 'values') return { rows: prepared.raw(true).all(...params) };
      return { rows: prepared.all(...params) };
    });

    await db.run(sql.raw('create table cards (id integer primary key, name text not null)'));
    await db.run(sql.raw("insert into cards (name) values ('FlashyDex test card')"));
    const rows = await db.all<{ name: string }>(sql.raw('select name from cards'));

    expect(rows).toEqual([{ name: 'FlashyDex test card' }]);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
