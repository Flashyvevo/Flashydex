// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { WebStorageError } from '../web-storage/contract';
import { runStatement, sqlVerb, mapSqliteError, type Oo1Db, type Sqlite3Api } from './executor';
import { loadSqlite3 } from './testing/sqlite-node';

let sqlite3: Sqlite3Api;
let db: Oo1Db;

const run = (sql: string, params: unknown[] = [], method: 'run' | 'all' | 'values' | 'get' = 'all') => runStatement(sqlite3, db, sql, params, method);

beforeAll(async () => {
  sqlite3 = await loadSqlite3();
});

describe('executor (mirrors sqlite-proxy.test.ts cases over real SQLite)', () => {
  const fresh = () => {
    db = new sqlite3.oo1.DB(':memory:') as unknown as Oo1Db;
    db.exec('create table t(a integer, b text); create table u(id integer primary key, name text not null unique, blob_col blob)');
  };

  it('detects the verb through comments and whitespace', () => {
    expect(sqlVerb('  -- hi\n select 1')).toBe('SELECT');
    expect(sqlVerb('/* c */ INSERT into t values (1)')).toBe('INSERT');
  });

  it('returns positional rows for reads and the first row (or []) for get', () => {
    fresh();
    run('insert into t(a, b) values (?, ?)', [1, 'x'], 'run');
    run('insert into t(a, b) values (?, ?)', [2, 'y'], 'run');
    expect(run('select a, b from t order by a', [], 'all')).toEqual([[1, 'x'], [2, 'y']]);
    expect(run('select a, b from t order by a', [], 'values')).toEqual([[1, 'x'], [2, 'y']]);
    expect(run('select a, b from t order by a', [], 'get')).toEqual([1, 'x']);
    expect(run('select a, b from t where a = 99', [], 'get')).toEqual([]);
    expect(run('select a, b from t where a = 99', [], 'all')).toEqual([]);
  });

  it('run returns [] for DML and DDL', () => {
    fresh();
    expect(run('insert into t(a, b) values (?, ?)', [1, 'x'], 'run')).toEqual([]);
    expect(run('create table x2 (id integer)', [], 'run')).toEqual([]);
    expect(run('PRAGMA foreign_keys = ON', [], 'run')).toEqual([]);
  });

  it('read PRAGMAs come back as rows', () => {
    fresh();
    expect(run('PRAGMA foreign_keys', [], 'values')).toEqual([[0]]);
    run('PRAGMA foreign_keys = ON', [], 'run');
    expect(run('PRAGMA foreign_keys', [], 'get')).toEqual([1]);
  });

  it('refuses bind values on statements without parameters', () => {
    fresh();
    expect(() => run('create table x (a)', [1], 'run')).toThrow(/bind/);
  });

  it('preserves duplicate column names and aliases positionally', () => {
    fresh();
    run('insert into u(id, name) values (1, ?)', ['alpha'], 'run');
    run('create table s(id integer, name text)');
    run('insert into s values (7, ?)', ['beta'], 'run');
    expect(run('select u.name, s.name, u.id as id, s.id as id from u, s', [], 'all')).toEqual([['alpha', 'beta', 1, 7]]);
    expect(run('select * from u join s on 1=1', [], 'get')).toEqual([1, 'alpha', null, 7, 'beta']);
    expect(run('select 1 as x, 2 as x, 3 as "X"', [], 'get')).toEqual([1, 2, 3]);
  });

  it('keeps null, 0, empty string, negative zero-ish, leading zeros and BLOBs exact', () => {
    fresh();
    run('insert into u(id, name, blob_col) values (?, ?, ?)', [0, '', new Uint8Array([0, 1, 2, 255])], 'run');
    run('insert into u(id, name, blob_col) values (?, ?, ?)', [1, '00123', null], 'run');
    const rows = run('select id, name, blob_col from u order by id', [], 'all') as unknown[][];
    expect(rows[0]?.[0]).toBe(0);
    expect(rows[0]?.[1]).toBe('');
    expect(rows[0]?.[2]).toBeInstanceOf(Uint8Array);
    expect(Array.from(rows[0]?.[2] as Uint8Array)).toEqual([0, 1, 2, 255]);
    expect(rows[1]).toEqual([1, '00123', null]);
    // undefined binds as NULL, booleans as 0/1
    run('insert into t(a, b) values (?, ?)', [undefined, 'u'], 'run');
    run('insert into t(a, b) values (?, ?)', [true, 'b'], 'run');
    expect(run("select a, b from t where b in ('u','b') order by b", [], 'all')).toEqual([[1, 'b'], [null, 'u']]);
  });

  it('multilingual text round-trips', () => {
    fresh();
    const text = '日本語 ポケモン Pokémon ☆ 🔥 ñ';
    run('insert into t(a, b) values (1, ?)', [text], 'run');
    expect(run('select b from t', [], 'get')).toEqual([text]);
  });

  describe('RETURNING', () => {
    it('all/values return the rows in projection order', () => {
      fresh();
      expect(run('insert into u(id, name) values (7, ?) returning name, id', ['n'], 'all')).toEqual([['n', 7]]);
      expect(run('update u set name = ? where id = 7 returning id, name', ['m'], 'values')).toEqual([[7, 'm']]);
    });
    it('get returns the first row and still drains multi-row DML to completion', () => {
      fresh();
      expect(run('insert into t(a,b) values (1,?),(2,?),(3,?) returning a', ['p', 'q', 'r'], 'get')).toEqual([1]);
      expect(run('select count(*) from t', [], 'get')).toEqual([3]); // all three inserted although only the first row was returned
      expect(run('delete from t where a > 100 returning a', [], 'get')).toEqual([]);
    });
    it('run returns RETURNING rows exactly like the native changes.values normalization', () => {
      fresh();
      expect(run('insert into u(id, name) values (9, ?) returning id, name', ['z'], 'run')).toEqual([[9, 'z']]);
      expect(run('insert into u(id, name) values (10, ?)', ['zz'], 'run')).toEqual([]);
    });
    it('a plain SELECT through run discards output', () => {
      fresh();
      run('insert into t(a, b) values (1, ?)', ['x'], 'run');
      expect(run('select a from t', [], 'run')).toEqual([]);
    });
  });

  describe('single-statement rule uses the SQLite prepare tail, not semicolon splitting', () => {
    it('rejects a trailing second statement', () => {
      fresh();
      expect(() => run('insert into t(a) values (1); insert into t(a) values (2)', [], 'run')).toThrow(WebStorageError);
      expect(() => run('select 1; select 2', [], 'all')).toThrow(/single|statement/i);
      expect(run('select count(*) from t', [], 'get')).toEqual([0]); // the first statement did not run either
    });
    it('rejects a trailing statement that only parses after the first ran (create then use)', () => {
      fresh();
      expect(() => run('create table later(x); insert into later values (1)', [], 'run')).toThrow(/single|statement/i);
    });
    it('allows a trailing semicolon, whitespace and comments', () => {
      fresh();
      expect(run('select 1 as one;  ', [], 'get')).toEqual([1]);
      expect(run('select 2; -- done\n /* c */ ', [], 'get')).toEqual([2]);
    });
    it('does not split on semicolons inside literals or trigger bodies', () => {
      fresh();
      run('insert into t(a, b) values (1, ?)', ['a;b;c'], 'run');
      expect(run("select b from t where b = 'a;b;c'", [], 'get')).toEqual(['a;b;c']);
      expect(run("select ';'", [], 'get')).toEqual([';']);
      expect(run('create trigger tr after insert on t begin insert into u(id,name) values (new.a, new.b); update u set name = name; end', [], 'run')).toEqual([]);
    });
    it('rejects empty SQL', () => {
      fresh();
      expect(() => run('   ', [], 'run')).toThrow(WebStorageError);
      expect(() => run('-- nothing', [], 'run')).toThrow(WebStorageError);
    });
  });

  describe('error mapping', () => {
    it('maps constraint failures to SQLITE with the engine message core translates, never the bound values', () => {
      fresh();
      run('insert into u(id, name) values (1, ?)', ['super-secret-value'], 'run');
      let error: unknown;
      try {
        run('insert into u(id, name) values (2, ?)', ['super-secret-value'], 'run');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(WebStorageError);
      const e = error as WebStorageError;
      expect(e.code).toBe('SQLITE');
      expect(e.message).toMatch(/UNIQUE constraint failed/);
      expect(e.message).not.toContain('super-secret-value');
      expect(e.details.commitState).toBe('not_started');
      expect(e.details.sqliteCode).toBeTypeOf('number');
    });
    it('NOT NULL and syntax errors do not leak SQL text', () => {
      fresh();
      expect(() => run('insert into u(id) values (5)', [], 'run')).toThrow(/NOT NULL constraint failed/);
      let message = '';
      try {
        run('selec secretcolumn from t', [], 'all');
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain('secretcolumn');
    });
    it('mapSqliteError maps FULL to QUOTA and IOERR to IO', () => {
      const full = Object.assign(new Error('SQLITE_FULL: sqlite3 result code 13: database or disk is full'), { resultCode: 13, name: 'SQLite3Error' });
      const io = Object.assign(new Error('disk I/O error'), { resultCode: 10 | (6 << 8), name: 'SQLite3Error' });
      expect(mapSqliteError(full).code).toBe('QUOTA');
      expect(mapSqliteError(io).code).toBe('IO');
      expect(mapSqliteError(io).details.sqliteCode).toBe(10 | (6 << 8));
    });
  });

  it('transaction state follows BEGIN/COMMIT/ROLLBACK', () => {
    fresh();
    const inTx = () => sqlite3.capi.sqlite3_get_autocommit(db as never) === 0;
    run('BEGIN IMMEDIATE', [], 'run');
    expect(inTx()).toBe(true);
    run('insert into t(a, b) values (1, ?)', ['x'], 'run');
    run('ROLLBACK', [], 'run');
    expect(inTx()).toBe(false);
    expect(run('select count(*) from t', [], 'get')).toEqual([0]);
    run('BEGIN IMMEDIATE', [], 'run');
    run('insert into t(a, b) values (1, ?)', ['x'], 'run');
    run('COMMIT', [], 'run');
    expect(run('select count(*) from t', [], 'get')).toEqual([1]);
  });

  it('finalizes statements even when binding fails (no leaked prepared statements)', () => {
    fresh();
    for (let i = 0; i < 300; i += 1) {
      try {
        run('insert into u(id, name) values (?, ?)', [1], 'run'); // wrong arity is fine (NULL name -> NOT NULL fails) but must not leak
      } catch {
        /* expected */
      }
    }
    // would exhaust the statement map / leak: the DB must still close cleanly
    expect(() => db.close()).not.toThrow();
  });
});
