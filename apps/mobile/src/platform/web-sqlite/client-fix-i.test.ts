// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebStorageError } from '../web-storage/contract';
import { createWebSqliteClient, type WebSqliteClientInternal, type WebSqliteClientOptions } from './client';
import { fromWire, type WireError } from './protocol';
import { createMemoryHarness, type MemoryHarness } from './testing/memory-env';

/** Fix-i: S5-01 (unknown COMMIT latches), S5-04 client half (closePath drain), S5-06 (deadlines + liveness). */
const USER = '/user/u-aaaaaa01.db';
const rw = { mode: 'rw', create: true, role: 'user' } as const;
const rwExisting = { mode: 'rw', create: false, role: 'user' } as const;

let h: MemoryHarness;
let client: WebSqliteClientInternal;
const make = (options: WebSqliteClientOptions = {}) => { client = createWebSqliteClient({ workerFactory: h.workerFactory, ...options }); return client; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  h = await createMemoryHarness();
  make();
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The worker really executed COMMIT; the client only ever sees an error reply (a lost / failed acknowledgement). */
function failCommitReply(code: WireError['code']): void {
  h.intercept = (response, request) => {
    const sql = (request.payload as { sql?: string } | undefined)?.sql;
    if (request.op !== 'exec' || response.kind !== 'response' || sql !== 'COMMIT') return undefined;
    h.intercept = null;
    return { ...response, ok: false, error: { code, message: 'injected', retryable: false, commitState: 'unknown', inTransaction: false } } as never;
  };
}

async function prepared() {
  const w = await client.driver(USER, 'w', rw);
  await w.proxy('create table t(a integer)', [], 'run');
  return w;
}

describe('S5-01 client: an unknown COMMIT outcome latches the connection', () => {
  for (const code of ['IO', 'QUOTA'] as const) {
    it(`${code} on the COMMIT reply: rejects commitState unknown, latches every rw wrapper + future ones, rejects queued admissions, reopen() shows the durable row`, async () => {
      const w = await prepared();
      const other = await client.driver(USER, 'other', rwExisting);
      await w.proxy('BEGIN IMMEDIATE', [], 'run');
      await w.proxy('insert into t values (1)', [], 'run');
      failCommitReply(code);
      const release = h.hold('exec');
      const commit = w.proxy('COMMIT', [], 'run');
      const queued = other.proxy('insert into t values (2)', [], 'run'); // admitted behind the owner's COMMIT
      commit.catch(() => undefined);
      queued.catch(() => undefined);
      await sleep(10);
      release();
      const error = await commit.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebStorageError);
      expect(error).toMatchObject({ code, commitState: 'unknown', details: { commitState: 'unknown' } });
      await expect(queued).rejects.toMatchObject({ code, details: { commitState: 'not_started' } });
      // the connection is frozen for everyone, including handles opened after the failure
      await expect(w.proxy('insert into t values (3)', [], 'run')).rejects.toMatchObject({ code });
      await expect(other.proxy('insert into t values (3)', [], 'run')).rejects.toMatchObject({ code });
      const late = await client.driver(USER, 'late', rwExisting);
      await expect(late.proxy('insert into t values (3)', [], 'run')).rejects.toMatchObject({ code });
      await w.reopen?.();
      expect(await w.proxy('select count(*), min(a) from t', [], 'get')).toEqual({ rows: [1, 1] }); // exactly the one durable row, never replayed
      await other.proxy('insert into t values (4)', [], 'run'); // unlatched for all wrappers
      await late.proxy('insert into t values (5)', [], 'run');
    });
  }

  it('a reply that never arrives (hung worker) is also unknown: liveness kills it, COMMIT rejects unknown, writes latch', async () => {
    make({ livenessIntervalMs: 10, livenessTimeoutMs: 60 });
    const w = await prepared();
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    h.hang = true;
    const error = await w.proxy('COMMIT', [], 'run').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'WORKER_DIED', commitState: 'unknown', details: { commitState: 'unknown' } });
    await expect(w.proxy('insert into t values (2)', [], 'run')).rejects.toMatchObject({ details: { commitState: 'not_started' } });
    h.hang = false;
    await w.reopen?.();
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] }); // the hung worker never executed it
  });

  it('a clean constraint failure on COMMIT (live worker, transaction rolled back / kept) does NOT latch', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table p(id integer primary key)', [], 'run');
    await w.proxy('create table c(pid integer references p(id) deferrable initially deferred)', [], 'run');
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into c values (7)', [], 'run');
    const error = await w.proxy('COMMIT', [], 'run').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebStorageError);
    expect((error as WebStorageError).details.commitState).not.toBe('unknown');
    expect((error as { commitState?: unknown }).commitState).toBeUndefined();
    await w.proxy('ROLLBACK', [], 'run');
    await w.proxy('insert into p values (1)', [], 'run'); // still writable
  });

  it('WebStorageError built from a wire error keeps details.commitState (the shape core reads)', () => {
    expect(fromWire({ code: 'IO', message: 'x', retryable: false, commitState: 'unknown' }).details.commitState).toBe('unknown');
  });
});

describe('S5-04 client half: closePath({ drain: true })', () => {
  it('lets the owner finish COMMIT + barrier BEFORE closing; new admissions get STALE_SESSION meanwhile', async () => {
    const w = await prepared();
    const other = await client.driver(USER, 'other', rwExisting);
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    let closed = false;
    const closing = client.closePath(USER, { drain: true }).then(() => { closed = true; });
    await sleep(20);
    expect(closed).toBe(false); // still waiting for the owner
    await expect(other.proxy('insert into t values (2)', [], 'run')).rejects.toMatchObject({ code: 'STALE_SESSION', details: { commitState: 'not_started' } });
    await expect(client.driver(USER, 'new', rwExisting)).rejects.toMatchObject({ code: 'BUSY' });
    await w.proxy('insert into t values (3)', [], 'run'); // the owner continues
    await w.proxy('COMMIT', [], 'run'); // not STALE_SESSION (the S5-04 reproduction)
    expect(closed).toBe(false); // the durable barrier of that COMMIT is still owed
    await w.afterCommit?.();
    await closing;
    expect(closed).toBe(true);
    expect((await client.stats()).openPaths).toEqual([]);
    const again = await client.driver(USER, 'again', rwExisting);
    expect(await again.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [2] }); // both rows were committed
  });

  it('an idle path closes at once; without drain the old behaviour is unchanged', async () => {
    await prepared();
    await client.closePath(USER, { drain: true });
    expect((await client.stats()).openPaths).toEqual([]);
    const w = await client.driver(USER, 'w', rwExisting);
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    const closing = client.closePath(USER); // no drain: `closing` is set immediately
    await expect(w.proxy('insert into t values (1)', [], 'run')).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await w.close(); // the owner's handle is released (ROLLBACK), which is what lets the non-drain close finish
    await closing.catch(() => undefined);
  });

  it('timeoutMs: a transaction that never ends cancels the drain with BUSY and admissions resume', async () => {
    const w = await prepared();
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await expect(client.closePath(USER, { drain: true, timeoutMs: 30 })).rejects.toMatchObject({ code: 'BUSY' });
    await w.proxy('insert into t values (1)', [], 'run');
    await w.proxy('COMMIT', [], 'run');
    await w.afterCommit?.();
    const other = await client.driver(USER, 'other', rwExisting);
    await other.proxy('insert into t values (2)', [], 'run');
  });

  it('a latched (unknown-COMMIT) path still drains: nothing is owed once the owner is gone', async () => {
    const w = await prepared();
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    failCommitReply('IO');
    await expect(w.proxy('COMMIT', [], 'run')).rejects.toMatchObject({ commitState: 'unknown' });
    await client.closePath(USER, { drain: true, timeoutMs: 500 });
  });
});

describe('S5-06 request liveness', () => {
  it('init that never answers rejects INIT_FAILED at the deadline, tears down, and a later init succeeds', async () => {
    make({ requestTimeoutMs: 40 });
    h.hang = true;
    await expect(client.init()).rejects.toMatchObject({ code: 'INIT_FAILED' });
    h.hang = false;
    await expect(client.init()).resolves.toBeDefined();
  });

  it('open that never answers rejects at the deadline (worker treated as dead, nothing replayed)', async () => {
    make({ requestTimeoutMs: 40 });
    await client.init();
    h.hang = true;
    await expect(client.driver(USER, 'w', rw)).rejects.toMatchObject({ code: 'WORKER_DIED', details: { commitState: 'unknown' } });
    h.hang = false;
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
  });

  it('a hung worker with SQL in flight: pending rejected as unknown, writes latched, reopen() recovers', async () => {
    make({ livenessIntervalMs: 10, livenessTimeoutMs: 60 });
    const w = await prepared();
    h.hang = true;
    const started = Date.now();
    const read = w.proxy('select count(*) from t', [], 'get');
    const write = w.proxy('insert into t values (1)', [], 'run');
    await expect(read).rejects.toMatchObject({ code: 'WORKER_DIED', details: { commitState: 'unknown' } });
    await expect(write).rejects.toMatchObject({ code: 'WORKER_DIED' });
    expect(Date.now() - started).toBeLessThan(2000);
    await expect(w.proxy('insert into t values (2)', [], 'run')).rejects.toMatchObject({ details: { commitState: 'not_started' } }); // no automatic retry, writes frozen
    h.hang = false;
    await w.reopen?.();
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] });
  });

  it('a slow but live worker (pings answered) is NOT declared dead', async () => {
    make({ livenessIntervalMs: 10, livenessTimeoutMs: 60 });
    const w = await prepared();
    const release = h.hold('exec');
    const slow = w.proxy('select count(*) from t', [], 'get');
    await sleep(250); // far beyond the liveness timeout; the worker keeps answering pings
    release();
    expect(await slow).toEqual({ rows: [0] });
    expect(h.log.filter((l) => l.op === 'ping').length).toBeGreaterThan(2);
    await w.proxy('insert into t values (1)', [], 'run'); // not latched
  });

  it('a hidden page never counts silence as death (throttled timers)', async () => {
    make({ livenessIntervalMs: 10, livenessTimeoutMs: 40 });
    const w = await prepared();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    h.hang = true;
    const read = w.proxy('select count(*) from t', [], 'get');
    let settled = false;
    read.then(() => { settled = true; }, () => { settled = true; });
    await sleep(200);
    expect(settled).toBe(false);
    vi.stubGlobal('document', { visibilityState: 'visible' });
    await expect(read).rejects.toMatchObject({ code: 'WORKER_DIED' }); // visible again and still silent
  });
});
