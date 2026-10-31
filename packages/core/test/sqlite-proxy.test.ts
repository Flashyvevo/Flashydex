import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { sql } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('executes real SQLite statements through the Drizzle sqlite-proxy adapter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'flashydex-core-'));
  cleanup.push(directory);
  const sqlite = new Database(join(directory, 'flashydex.db'));
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
  await db.run(sql`insert into cards (name) values ${'FlashyDex test card'}`);
  const rows = await db.all<{ name: string }>(sql`select name from cards`);

  expect(rows).toEqual([{ name: 'FlashyDex test card' }]);
  sqlite.close();
});
