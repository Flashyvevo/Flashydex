// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SqlDriver } from '@flashydex/core';
import { createWriteGate } from '../web-storage/write-gate';
import { classifySql, isMutationKind } from './sql-class';

const kind = (sql: string) => classifySql(sql).kind;

describe('classifySql (S6-05)', () => {
  it('plain statements', () => {
    expect(kind('SELECT 1')).toBe('read');
    expect(kind('  -- c\n select * from t')).toBe('read');
    expect(kind('VALUES (1)')).toBe('read');
    expect(kind('EXPLAIN INSERT INTO t VALUES (1)')).toBe('read');
    for (const w of ['INSERT INTO t VALUES (1)', 'update t set a=1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'CREATE TABLE x(a)', 'DROP TABLE x', 'ALTER TABLE x ADD b', 'VACUUM', 'REINDEX', 'ANALYZE', 'ATTACH DATABASE \'x\' AS y']) {
      expect(kind(w), w).toBe('write');
    }
  });

  it('unknown verbs are writes (conservative)', () => {
    expect(kind('FROBNICATE x')).toBe('write');
  });

  it('transaction control', () => {
    expect(kind('BEGIN IMMEDIATE')).toBe('begin');
    expect(kind('COMMIT')).toBe('commit');
    expect(kind('end transaction')).toBe('commit');
    expect(kind('ROLLBACK')).toBe('rollback');
    expect(kind('ROLLBACK TRANSACTION')).toBe('rollback');
    expect(classifySql('SAVEPOINT "Sp1"')).toEqual({ kind: 'savepoint', name: 'sp1' });
    expect(classifySql('RELEASE SAVEPOINT sp1')).toEqual({ kind: 'release', name: 'sp1' });
    expect(classifySql('release sp1;')).toEqual({ kind: 'release', name: 'sp1' });
    expect(classifySql('ROLLBACK TO sp1')).toEqual({ kind: 'rollback_to', name: 'sp1' });
    expect(classifySql('ROLLBACK TRANSACTION TO SAVEPOINT sp1')).toEqual({ kind: 'rollback_to', name: 'sp1' });
  });

  it('WITH is a write when a DML verb follows the CTE list, a read otherwise', () => {
    expect(kind('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe('write');
    expect(kind('with x as (select 1) update t set a = 1')).toBe('write');
    expect(kind('WITH x AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM x)')).toBe('write');
    expect(kind('WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x')).toBe('write');
    expect(kind('WITH x AS (DELETE FROM t RETURNING a) SELECT * FROM x')).toBe('write');
    expect(kind('WITH x AS (SELECT 1 AS a) SELECT a FROM x')).toBe('read');
    // keywords inside literals / quoted identifiers / comments / the replace() function do not count
    expect(kind("WITH x AS (SELECT 'INSERT' AS a, \"update\" FROM t) SELECT a FROM x")).toBe('read');
    expect(kind('WITH x AS (SELECT replace(a, 1, 2) FROM t) SELECT * FROM x -- delete')).toBe('read');
  });

  it('PRAGMA: assignment/call = write, bare name = read, known introspection calls = read', () => {
    expect(kind('PRAGMA user_version = 99')).toBe('write');
    expect(kind('PRAGMA main.user_version=1')).toBe('write');
    expect(kind('PRAGMA user_version(3)')).toBe('write');
    expect(kind('PRAGMA journal_mode = WAL')).toBe('write');
    expect(kind('pragma writable_schema = 1')).toBe('write');
    expect(kind('PRAGMA user_version')).toBe('read');
    expect(kind('PRAGMA integrity_check')).toBe('read');
    expect(kind('PRAGMA foreign_key_check')).toBe('read');
    expect(kind('PRAGMA table_info(t)')).toBe('read');
    expect(kind('PRAGMA optimize')).toBe('write');
    expect(kind('PRAGMA wal_checkpoint')).toBe('write');
    // connection-local, issued by core on every open/recover
    expect(kind('PRAGMA foreign_keys = ON')).toBe('read');
  });

  it('isMutationKind: latch/read-only refuse writes and BEGIN/COMMIT/SAVEPOINT/RELEASE, never ROLLBACK / ROLLBACK TO / reads', () => {
    for (const k of ['write', 'begin', 'commit', 'savepoint', 'release'] as const) expect(isMutationKind(k)).toBe(true);
    for (const k of ['read', 'rollback', 'rollback_to'] as const) expect(isMutationKind(k)).toBe(false);
  });
});

function recordingDriver(): { driver: SqlDriver; calls: string[] } {
  const calls: string[] = [];
  return { calls, driver: { label: 'fake', proxy: async (sql: string) => { calls.push(sql); return { rows: [] }; }, close: async () => undefined } as unknown as SqlDriver };
}

describe('write gate with the shared classifier (S6-05)', () => {
  it('closed: WITH..INSERT, SAVEPOINT, writable PRAGMA and plain writes are MAINTENANCE and never reach the driver', async () => {
    const gate = createWriteGate();
    const { driver, calls } = recordingDriver();
    const wrapped = gate.wrap(driver);
    gate.close();
    for (const sql of ['INSERT INTO t VALUES (1)', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'SAVEPOINT x', 'PRAGMA user_version = 99', 'BEGIN IMMEDIATE', 'ATTACH \'a\' AS b']) {
      await expect(wrapped.proxy(sql, [], 'run'), sql).rejects.toMatchObject({ name: 'MaintenanceError' });
    }
    expect(calls).toEqual([]);
    await wrapped.proxy('SELECT 1', [], 'all');
    await wrapped.proxy('PRAGMA user_version', [], 'all');
    await wrapped.proxy('WITH x AS (SELECT 1) SELECT * FROM x', [], 'all');
    expect(calls).toHaveLength(3);
  });

  it('an admitted SAVEPOINT-opened transaction counts as pending until the outermost RELEASE; ROLLBACK TO keeps it open', async () => {
    const gate = createWriteGate();
    const { driver, calls } = recordingDriver();
    const wrapped = gate.wrap(driver);
    await wrapped.proxy('SAVEPOINT a', [], 'run');
    expect(gate.pending()).toBe(1);
    await wrapped.proxy('SAVEPOINT b', [], 'run');
    gate.close();
    // already admitted: keeps running to its end while the gate is closed
    await wrapped.proxy('INSERT INTO t VALUES (1)', [], 'run');
    await wrapped.proxy('ROLLBACK TO b', [], 'run');
    expect(gate.pending()).toBe(1);
    await wrapped.proxy('RELEASE b', [], 'run');
    expect(gate.pending()).toBe(1);
    await wrapped.proxy('RELEASE SAVEPOINT a', [], 'run');
    expect(gate.pending()).toBe(0);
    expect(calls).toHaveLength(6);
    await expect(wrapped.proxy('SAVEPOINT c', [], 'run')).rejects.toMatchObject({ name: 'MaintenanceError' });
  });

  it('BEGIN + SAVEPOINT: RELEASE of the inner savepoint does not end the BEGIN transaction; COMMIT does', async () => {
    const gate = createWriteGate();
    const wrapped = gate.wrap(recordingDriver().driver);
    await wrapped.proxy('BEGIN', [], 'run');
    await wrapped.proxy('SAVEPOINT s', [], 'run');
    await wrapped.proxy('RELEASE s', [], 'run');
    expect(gate.pending()).toBe(1);
    await wrapped.proxy('ROLLBACK', [], 'run');
    expect(gate.pending()).toBe(0);
  });
});

describe('classifySql tokenizer (S7-02)', () => {
  const SOL = ["WITH x AS (SELECT '--') INSERT INTO t VALUES(1)", 'PRAGMA "user_version" = 99', '; INSERT INTO t VALUES(1)'];

  it('Sol strings classify as write', () => {
    for (const sql of SOL) expect(kind(sql), sql).toBe('write');
  });

  it('comment-like text inside quoted tokens does not hide or fake anything', () => {
    expect(kind("WITH x AS (SELECT '--') SELECT * FROM x")).toBe('read');
    expect(kind("WITH x AS (SELECT '/*') SELECT '*/' FROM x")).toBe('read');
    expect(kind('WITH x AS (SELECT "--" FROM t) SELECT * FROM x')).toBe('read');
    expect(kind("WITH x AS (SELECT 'it''s --') INSERT INTO t VALUES(1)")).toBe('write');
    expect(kind('WITH x AS (SELECT [a--b] FROM t) UPDATE t SET a = 1')).toBe('write');
    expect(kind('WITH x AS (SELECT `a--b` FROM t) SELECT * FROM x')).toBe('read');
    expect(kind('WITH x AS (SELECT 1) /* c */ INSERT INTO t VALUES(1)')).toBe('write');
    expect(kind('WITH x AS (SELECT 1) -- INSERT\n SELECT * FROM x')).toBe('read');
  });

  it('leading semicolons / whitespace / comments are skipped before the verb', () => {
    for (const lead of [';', ' ; ;', '/* a */;', '-- x\n;\n']) {
      expect(kind(`${lead} INSERT INTO t VALUES(1)`), lead).toBe('write');
      expect(kind(`${lead} SELECT 1`), lead).toBe('read');
      expect(classifySql(`${lead} BEGIN`).kind).toBe('begin');
      expect(classifySql(`${lead} SAVEPOINT a`)).toEqual({ kind: 'savepoint', name: 'a' });
    }
  });

  it('quoted / schema-qualified PRAGMA names classify like bare ones', () => {
    expect(kind('PRAGMA "user_version" = 99')).toBe('write');
    expect(kind('PRAGMA [user_version]=1')).toBe('write');
    expect(kind('PRAGMA `user_version`(3)')).toBe('write');
    expect(kind("PRAGMA 'user_version' = 3")).toBe('write');
    expect(kind('PRAGMA main."user_version" = 99')).toBe('write');
    expect(kind('PRAGMA "main"."user_version" = 99')).toBe('write');
    expect(kind('PRAGMA "user_version"')).toBe('read');
    expect(kind('PRAGMA "table_info"(t)')).toBe('read');
    expect(kind('PRAGMA "foreign_keys" = ON')).toBe('read'); // intentional connection-local policy, quoted or not
    expect(kind('PRAGMA "optimize"')).toBe('write');
  });

  it('anything the tokenizer cannot classify confidently is a write', () => {
    for (const sql of ["SELECT 'unterminated", 'PRAGMA "user_version = 1', 'PRAGMA = 1', 'PRAGMA', '(SELECT 1)', '1', "WITH x AS (SELECT 'oops) INSERT INTO t VALUES(1)", 'SAVEPOINT', 'RELEASE']) {
      expect(isMutationKind(kind(sql)), sql).toBe(true);
    }
  });

  it('empty / comment-only input stays a read (nothing executes)', () => {
    expect(kind('')).toBe('read');
    expect(kind('-- nothing')).toBe('read');
    expect(kind(' ; ')).toBe('read');
  });

  it('closed gate refuses all three Sol spellings and still admits the read CTE', async () => {
    const gate = createWriteGate();
    const { driver, calls } = recordingDriver();
    const wrapped = gate.wrap(driver);
    gate.close();
    for (const sql of SOL) await expect(wrapped.proxy(sql, [], 'run'), sql).rejects.toMatchObject({ name: 'MaintenanceError' });
    expect(calls).toEqual([]);
    await wrapped.proxy("WITH x AS (SELECT '--') SELECT * FROM x", [], 'all');
    expect(calls).toHaveLength(1);
  });
});
