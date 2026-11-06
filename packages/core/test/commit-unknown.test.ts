import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, isUnknownCommit, PersistenceError, type ProxyCallback, type SqlDriver } from '../src';
import { createNodeDriver } from '../src/testing/node-driver';

/** S5-01: Db.runTransaction must treat a COMMIT whose outcome is unknown as a persistence failure: no ROLLBACK, latch, PersistenceError. */
type CommitMode = 'ok' | { reject: Error; apply: boolean };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'flashydex-commit-'));
  const base = createNodeDriver(join(dir, 'x.db'), { label: 'x' });
  const control = { commit: 'ok' as CommitMode, rollbacks: 0, commits: 0 };
  const proxy: ProxyCallback = async (sql, params, method) => {
    if (sql === 'ROLLBACK') control.rollbacks += 1;
    if (sql === 'COMMIT') {
      control.commits += 1;
      if (control.commit !== 'ok') {
        const { reject, apply } = control.commit;
        control.commit = 'ok';
        if (apply) await base.proxy(sql, params, method); // the engine really committed, only the acknowledgement was lost
        throw reject;
      }
    }
    return base.proxy(sql, params, method);
  };
  const driver: SqlDriver = { label: 'x', proxy, reopen: () => base.reopen!(), close: () => base.close() };
  const db = new Db(driver);
  await db.initialize();
  await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  cleanup.push(async () => { await db.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const count = async () => Number(await db.scalar('SELECT COUNT(*) FROM t'));
  return { db, control, count };
}
const unknown = (message = 'IO') => Object.assign(new Error(message), { commitState: 'unknown' });
const insert = (v: string) => async (tx: { run(sql: string, params?: readonly unknown[]): Promise<void> }) => { await tx.run('INSERT INTO t (v) VALUES (?)', [v]); };

describe('isUnknownCommit', () => {
  it('is structural: own commitState or details.commitState === unknown', () => {
    expect(isUnknownCommit(unknown())).toBe(true);
    expect(isUnknownCommit(Object.assign(new Error('x'), { details: { commitState: 'unknown' } }))).toBe(true);
    expect(isUnknownCommit(Object.assign(new Error('x'), { commitState: 'rolled_back' }))).toBe(false);
    expect(isUnknownCommit(new Error('x'))).toBe(false);
    expect(isUnknownCommit(null)).toBe(false);
    expect(isUnknownCommit('unknown')).toBe(false);
  });
});

describe('Db.runTransaction COMMIT outcome', () => {
  it('PRE-COMMIT error in the callback: ROLLBACK, no latch, plain translated error', async () => {
    const { db, control, count } = await setup();
    await expect(db.transaction(async (tx) => { await insert('a')(tx); await tx.run('INSERT INTO t (v) VALUES (NULL)'); })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(control.rollbacks).toBe(1);
    expect(control.commits).toBe(0);
    expect(db.status()).toMatchObject({ writable: true, reason: 'ok' });
    expect(await count()).toBe(0);
  });

  it('COMMIT rejected cleanly (rolled_back): ROLLBACK attempted, NOT latched, not a PersistenceError', async () => {
    const { db, control } = await setup();
    control.commit = { reject: Object.assign(new Error('database is locked'), { commitState: 'rolled_back' }), apply: false };
    const error = await db.transaction(insert('a')).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PersistenceError);
    expect(control.rollbacks).toBe(1);
    expect(db.status()).toMatchObject({ writable: true, reason: 'ok' });
    await db.transaction(insert('b')); // still usable
  });

  it('COMMIT unknown: no ROLLBACK, latches, PersistenceError, every later write refused', async () => {
    const { db, control } = await setup();
    const seen: string[] = [];
    db.subscribe((s) => seen.push(s.reason));
    control.commit = { reject: unknown(), apply: false };
    await expect(db.transaction(insert('a'))).rejects.toBeInstanceOf(PersistenceError);
    expect(control.rollbacks).toBe(0);
    expect(db.status()).toMatchObject({ writable: false, reason: 'persistence_failed' });
    expect(seen.at(-1)).toBe('persistence_failed');
    await expect(db.transaction(insert('b'))).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
    expect(control.commits).toBe(1); // the refused retry never reached COMMIT
  });

  it('COMMIT unknown, never applied: recover() reopens and the row is absent', async () => {
    const { db, control, count } = await setup();
    control.commit = { reject: unknown(), apply: false };
    await expect(db.transaction(insert('a'))).rejects.toBeInstanceOf(PersistenceError);
    await db.recover();
    expect(db.status().writable).toBe(true);
    expect(await count()).toBe(0);
  });

  it('lost ack but durable: recover() shows the row exactly once; core never replays it', async () => {
    const { db, control, count } = await setup();
    control.commit = { reject: unknown(), apply: true };
    await expect(db.transaction(insert('a'))).rejects.toBeInstanceOf(PersistenceError);
    expect(control.rollbacks).toBe(0);
    await db.recover();
    expect(await count()).toBe(1);
    expect(await count()).toBe(1); // not duplicated by any automatic retry
  });
});
