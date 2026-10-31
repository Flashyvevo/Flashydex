import { describe, expect, it } from 'vitest';
import { createProxyCallback, normalizeRows, sqlVerb, type ProxyConnection } from './sqlite-proxy';

function fakeConnection(overrides: Partial<ProxyConnection> = {}) {
  const calls: Array<{ kind: string; sql: string; params?: unknown[]; transaction?: boolean; returnMode?: string }> = [];
  const connection: ProxyConnection = {
    async execute(sql, transaction) { calls.push({ kind: 'execute', sql, transaction }); return {}; },
    async run(sql, params, transaction, returnMode) { calls.push({ kind: 'run', sql, params, transaction, returnMode }); return { changes: { changes: 1 } }; },
    async query(sql, params) { calls.push({ kind: 'query', sql, params }); return { values: [{ a: 1, b: 'x' }] }; },
    ...overrides
  };
  return { connection, calls };
}

describe('sqlite proxy adapter', () => {
  it('detects the verb through comments and whitespace', () => {
    expect(sqlVerb('  -- hi\n select 1')).toBe('SELECT');
    expect(sqlVerb('/* c */ INSERT into t values (1)')).toBe('INSERT');
  });

  it('routes by verb and tracks BEGIN/COMMIT so inner runs are not double-wrapped', async () => {
    const { connection, calls } = fakeConnection();
    const proxy = createProxyCallback(connection);
    await proxy('insert into t(a) values (?)', [1], 'run');
    await proxy('BEGIN', [], 'run');
    await proxy('insert into t(a) values (?)', [2], 'run');
    await proxy('COMMIT', [], 'run');
    await proxy('create table t2 (id integer)', [], 'run');
    expect(calls.map((c) => [c.kind, c.transaction])).toEqual([
      ['run', true], ['execute', false], ['run', false], ['execute', false], ['execute', false]
    ]);
  });

  it('returns positional rows for reads and maps RETURNING values onto rows', async () => {
    const { connection } = fakeConnection({
      async run() { return { changes: { changes: 1, values: [{ ios_columns: ['id', 'name'] }, { name: 'n', id: 7 }] } }; }
    });
    const proxy = createProxyCallback(connection);
    expect(await proxy('select a, b from t', [], 'all')).toEqual({ rows: [[1, 'x']] });
    expect(await proxy('select a, b from t', [], 'get')).toEqual({ rows: [1, 'x'] });
    expect(await proxy('insert into t(name) values (?) returning id, name', ['n'], 'all')).toEqual({ rows: [[7, 'n']] });
  });

  it('normalizes the iOS ios_columns header row', () => {
    expect(normalizeRows([{ ios_columns: ['b', 'a'] }, { a: 1, b: 2 }])).toEqual([[2, 1]]);
    expect(normalizeRows(undefined)).toEqual([]);
  });

  it('refuses bind values on DDL', async () => {
    const { connection } = fakeConnection();
    await expect(createProxyCallback(connection)('create table x (a)', [1], 'run')).rejects.toThrow(/bind/);
  });
});
