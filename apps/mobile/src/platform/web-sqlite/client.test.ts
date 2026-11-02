// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { WebStorageError } from '../web-storage/contract';
import { createWebSqliteClient, type WebSqliteClientInternal } from './client';
import { createMemoryHarness, type MemoryHarness } from './testing/memory-env';

const USER = '/user/u-aaaaaa01.db';
const CAT = '/catalog-en/g-bbbbbb01.db';
const CAT2 = '/catalog-en/g-bbbbbb02.db';

let h: MemoryHarness;
let client: WebSqliteClientInternal;

beforeEach(async () => {
  h = await createMemoryHarness();
  client = createWebSqliteClient({ workerFactory: h.workerFactory });
});

const rw = { mode: 'rw', create: true, role: 'user' } as const;

/** A real SQLite file (>= `rows` rows) built through the same engine, for staging fixtures. */
function makeDbFile(rows: number): Uint8Array {
  const db = new h.sqlite3.oo1.DB(':memory:') as unknown as { exec(sql: string): void; close(): void; pointer: number };
  db.exec('create table big(id integer primary key, payload text)');
  db.exec('begin');
  for (let i = 0; i < rows; i += 1) db.exec(`insert into big(payload) values ('${'x'.repeat(900)}${i}')`);
  db.exec('commit');
  const bytes = h.sqlite3.capi.sqlite3_js_db_export(db as never);
  db.close();
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('init', () => {
  it('is idempotent and reports the runtime SQLite version', async () => {
    const [a, b] = await Promise.all([client.init(), client.init()]);
    expect(a).toBe(b);
    expect(a.vfs).toBe('opfs-sahpool');
    expect(a.poolDirectory).toBe('/flashydex-sqlite-v1');
    expect(a.sqliteVersion).toMatch(/^3\.\d+\.\d+/);
    expect(a.capacity).toBeGreaterThanOrEqual(16);
    expect(h.cores).toHaveLength(1);
  });

  it('init failure rethrows, tears the worker down and a later init retries; storage is untouched', async () => {
    const failing = createWebSqliteClient({ workerFactory: h.workerFactory, fault: { initFail: 'after-vfs' } });
    h.pool.files.set(USER, new Uint8Array([1, 2, 3]));
    await expect(failing.init()).rejects.toMatchObject({ code: 'IO' });
    expect(h.pool.files.get(USER)).toEqual(new Uint8Array([1, 2, 3]));
    await expect(client.init()).resolves.toBeDefined();
  });
});

describe('driver basics', () => {
  it('creates, writes, persists across close/reopen and returns positional rows', async () => {
    const d = await client.driver(USER, 'user', rw);
    await d.proxy('create table t(a integer, b text)', [], 'run');
    await d.proxy('insert into t values (?, ?)', [0, ''], 'run');
    expect(await d.proxy('select a, b from t', [], 'values')).toEqual({ rows: [[0, '']] });
    expect(await d.proxy('select a, b from t', [], 'get')).toEqual({ rows: [0, ''] });
    await d.close();
    const again = await client.driver(USER, 'user', { mode: 'rw', create: false, role: 'user' });
    expect(await again.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [1] });
  });

  it('create:false on a missing file is NOT_FOUND; bad paths are INVALID_PATH', async () => {
    await expect(client.driver(USER, 'x', { mode: 'rw', create: false, role: 'user' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(client.driver('/etc/passwd', 'x', rw)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(client.unlink('../x')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('constraint errors keep SQLite text (core translates it) and never include bound values', async () => {
    const d = await client.driver(USER, 'user', rw);
    await d.proxy('create table u(id integer primary key, name text unique)', [], 'run');
    await d.proxy('insert into u values (1, ?)', ['hunter2-secret'], 'run');
    const error = await d.proxy('insert into u values (2, ?)', ['hunter2-secret'], 'run').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebStorageError);
    expect((error as Error).message).toMatch(/UNIQUE constraint failed/);
    expect((error as Error).message).not.toContain('hunter2-secret');
  });

  it('a read-only wrapper rejects writes', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    await expect(r.proxy('insert into t values (1)', [], 'run')).rejects.toMatchObject({ code: 'SQLITE' });
    expect(await r.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] });
  });
});

describe('one physical connection per path, one queue, transaction ownership', () => {
  it('shares the physical connection (a single open) and refcounts wrappers', async () => {
    const w = await client.driver(USER, 'w', rw);
    const r1 = await client.driver(USER, 'r1', { mode: 'ro', create: false, role: 'validation' });
    const r2 = await client.driver(USER, 'r2', { mode: 'ro', create: false, role: 'validation' });
    expect(h.log.filter((l) => l.op === 'open')).toHaveLength(1);
    await w.proxy('create table t(a)', [], 'run');
    await r1.close();
    expect(h.log.filter((l) => l.op === 'close')).toHaveLength(0);
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] }); // closing one wrapper does not close the writer
    await r2.close();
    await w.close();
    expect(h.log.filter((l) => l.op === 'close')).toHaveLength(1);
    expect((await client.stats()).openPaths).toEqual([]);
  });

  it("a reader's statement waits for the owner's COMMIT (no slip-in) and no BEGIN is injected", async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    const order: string[] = [];
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    const read = r.proxy('select count(*) from t', [], 'get').then((v) => { order.push('read'); return v; });
    await w.proxy('insert into t values (1)', [], 'run');
    await new Promise((resolve) => setTimeout(resolve, 30)); // give a (buggy) slip-in every chance
    expect(order).toEqual([]);
    expect((await client.stats()).openPaths[0]?.inTransaction).toBe(true);
    await w.proxy('insert into t values (2)', [], 'run');
    await w.proxy('COMMIT', [], 'run');
    expect(await read).toEqual({ rows: [2] }); // sees the committed state, never a partial one
    expect((await client.stats()).openPaths[0]?.inTransaction).toBe(false);
    const sqlOps = h.log.filter((l) => l.op === 'exec').length;
    expect(sqlOps).toBe(6); // create, BEGIN, 2 inserts, COMMIT, select: no injected BEGIN/COMMIT
  });

  it('ROLLBACK ends ownership and queued readers resume', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    const read = r.proxy('select count(*) from t', [], 'get');
    await w.proxy('ROLLBACK', [], 'run');
    expect(await read).toEqual({ rows: [0] });
  });

  it('closing the owner wrapper mid-transaction rolls back and releases waiters', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    const read = r.proxy('select count(*) from t', [], 'get');
    await w.close();
    expect(await read).toEqual({ rows: [0] });
  });

  it('separate paths do not block each other', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    h.pool.files.set(CAT, new Uint8Array(0));
    const c = await client.driver(CAT, 'c', { mode: 'rw', create: true, role: 'catalog' });
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await expect(c.proxy('select 1', [], 'get')).resolves.toEqual({ rows: [1] });
    await w.proxy('ROLLBACK', [], 'run');
  });

  it('closePath drains queued work, then invalidates every wrapper', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    const queued = w.proxy('insert into t values (1)', [], 'run');
    await client.closePath(USER);
    await expect(queued).resolves.toEqual({ rows: [] });
    await expect(r.proxy('select 1', [], 'get')).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await expect(w.proxy('select 1', [], 'get')).rejects.toMatchObject({ code: 'STALE_SESSION' });
    await r.close(); // closing an invalidated wrapper is a no-op
    const again = await client.driver(USER, 'w2', { mode: 'rw', create: false, role: 'user' });
    expect(await again.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [1] });
  });

  it('afterCommit is the durable barrier and exists only on rw wrappers', async () => {
    const w = await client.driver(USER, 'w', rw);
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    expect(r.afterCommit).toBeUndefined();
    await w.proxy('create table t(a)', [], 'run');
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    await w.proxy('COMMIT', [], 'run');
    await w.afterCommit?.();
    expect(h.log.filter((l) => l.op === 'durableBarrier')).toHaveLength(1);
    // the barrier is ordered after the COMMIT
    const ops = h.log.map((l) => l.op);
    expect(ops.lastIndexOf('durableBarrier')).toBeGreaterThan(ops.lastIndexOf('exec'));
  });
});

describe('worker death', () => {
  it('rejects the in-flight COMMIT as WORKER_DIED/unknown, latches writes, reopen re-inits without replay', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    await w.proxy('BEGIN IMMEDIATE', [], 'run');
    await w.proxy('insert into t values (1)', [], 'run');
    const release = h.hold('exec');
    const commit = w.proxy('COMMIT', [], 'run');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = w.proxy('insert into t values (2)', [], 'run');
    client.__terminateWorker();
    release();
    await expect(commit).rejects.toMatchObject({ code: 'WORKER_DIED', details: { commitState: 'unknown' } });
    await expect(queued).rejects.toMatchObject({ code: 'WORKER_DIED' });
    await expect(w.proxy('insert into t values (3)', [], 'run')).rejects.toMatchObject({ details: { commitState: 'not_started' } });
    await expect(w.proxy('select 1', [], 'get')).rejects.toMatchObject({ code: expect.stringMatching(/WORKER_DIED|STALE_SESSION/) });
    const sessions = h.cores.length;
    await w.reopen?.();
    expect(h.cores.length).toBe(sessions + 1); // a fresh worker/session
    // nothing was replayed: the uncommitted insert is gone, the table is empty
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] });
    await w.proxy('insert into t values (9)', [], 'run'); // unlatched
  });

  it('read-only paths recover on their own after a worker restart', async () => {
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a)', [], 'run');
    await w.close();
    const r = await client.driver(USER, 'r', { mode: 'ro', create: false, role: 'validation' });
    client.__terminateWorker();
    expect(await r.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] });
  });
});

describe('protocol safety (worker core)', () => {
  it('rejects a protocol mismatch and a stale session with one terminal response each', async () => {
    await client.init();
    const core = h.cores[0] as (typeof h.cores)[number];
    const sent: unknown[] = [];
    const posted = (core as unknown as { options: { post: (m: unknown) => void } }).options;
    const original = posted.post;
    posted.post = (m) => { sent.push(m); };
    await core.handle({ protocol: 2 as never, sessionId: 'whatever', requestId: 1, op: 'list', payload: {} });
    await core.handle({ protocol: 1, sessionId: 'not-the-session', requestId: 2, op: 'list', payload: {} });
    posted.post = original;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ ok: false, requestId: 1, error: { code: 'PROTOCOL_MISMATCH' } });
    expect(sent[1]).toMatchObject({ ok: false, requestId: 2, error: { code: 'STALE_SESSION' } });
  });

  it('batch: ordered, bounded, not atomic by default, atomic only when asked', async () => {
    await client.init();
    const w = await client.driver(USER, 'w', rw);
    await w.proxy('create table t(a integer primary key)', [], 'run');
    const core = h.cores[0] as (typeof h.cores)[number];
    const session = (await client.stats()).sessionId as string;
    const call = async (op: 'batch', payload: unknown) => {
      const messages: { ok: boolean; payload?: unknown; error?: { code: string } }[] = [];
      const options = (core as unknown as { options: { post: (m: never) => void } }).options;
      const original = options.post;
      options.post = (m) => { messages.push(m as never); };
      await core.handle({ protocol: 1, sessionId: session, requestId: 900, op, dbId: 1, payload });
      options.post = original;
      return messages[0] as (typeof messages)[number];
    };
    const st = (sql: string, params: unknown[] = []) => ({ sql, params, method: 'run' as const });
    const partial = await call('batch', { statements: [st('insert into t values (1)'), st('insert into t values (1)'), st('insert into t values (2)')] });
    expect(partial.ok).toBe(true);
    expect((partial.payload as { failedAt: number }).failedAt).toBe(1);
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [1] }); // first applied, not rolled back, third never ran
    const atomic = await call('batch', { atomic: true, statements: [st('insert into t values (5)'), st('insert into t values (5)')] });
    expect((atomic.payload as { error: { commitState: string } }).error.commitState).toBe('rolled_back');
    expect(await w.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [1] });
    const tooMany = await call('batch', { statements: Array.from({ length: 26 }, () => st('select 1')) });
    expect(tooMany.ok).toBe(false);
    const tooBig = await call('batch', { statements: [st('select ?', ['x'.repeat(300 * 1024)])] });
    expect(tooBig.ok).toBe(false);
  });
});

describe('importFromStaging', () => {
  const stage = (bytes: Uint8Array, job = 'job12345', name = 'catalog.db.part') => h.staging.files.set(`${job}/${name}`, bytes);

  it('streams in <= 256 KiB slices, verifies bytes + sha256, and the result opens as a database', async () => {
    const file = makeDbFile(2500); // ~2.5 MB
    stage(file);
    await client.init();
    client.__messageStats(true);
    const progress: number[] = [];
    const result = await client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file), onProgress: (n) => progress.push(n) });
    expect(result.bytes).toBe(file.length);
    expect(result.sha256).toBe(sha(file));
    expect(result.maxChunkBytes).toBeLessThanOrEqual(256 * 1024);
    expect(result.maxChunkBytes).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(0);
    expect(client.__messageStats().maxBufferBytes).toBeLessThan(1024 * 1024); // no >= 1 MiB ArrayBuffer crossed postMessage
    const d = await client.driver(CAT, 'validate', { mode: 'ro', create: false, role: 'validation' });
    expect(await d.proxy('select count(*) from big', [], 'get')).toEqual({ rows: [2500] });
  });

  it('wrong hash or size -> INTEGRITY and the target is unlinked', async () => {
    const file = makeDbFile(600);
    stage(file);
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(CAT);
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length + 512, expectedSha256: sha(file) })).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).not.toContain(CAT);
  });

  it('a short read from staging fails with IO and leaves nothing behind; other files stay intact', async () => {
    const file = makeDbFile(600);
    stage(file);
    const d = await client.driver(USER, 'w', rw);
    await d.proxy('create table keep(a)', [], 'run');
    h.staging.shortReadAt = 256 * 1024;
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) })).rejects.toMatchObject({ code: 'IO' });
    expect(await client.listFiles()).toEqual([USER]);
    expect(await d.proxy('select count(*) from sqlite_master', [], 'get')).toEqual({ rows: [1] });
  });

  it('injected quota error -> QUOTA, short fault -> INTEGRITY; nothing else touched', async () => {
    const file = makeDbFile(1200);
    stage(file);
    const user = await client.driver(USER, 'w', rw);
    await user.proxy('create table keep(a)', [], 'run');
    await client.__setFault({ supplier: { kind: 'quota', afterBytes: 256 * 1024 } });
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) })).rejects.toMatchObject({ code: 'QUOTA' });
    await client.__setFault({ supplier: { kind: 'short', afterBytes: 256 * 1024 } });
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) })).rejects.toMatchObject({ code: 'INTEGRITY' });
    expect(await client.listFiles()).toEqual([USER]);
  });

  it('per-path ownership: an open target, a concurrent import and an existing target are BUSY; unlink of an open path is BUSY', async () => {
    const file = makeDbFile(600);
    stage(file);
    const release = h.hold('stageImport');
    const input = { source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) };
    const first = client.importFromStaging(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(client.importFromStaging(input)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(client.driver(CAT, 'x', { mode: 'ro', create: false, role: 'validation' })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(client.unlink(CAT)).rejects.toMatchObject({ code: 'BUSY' });
    release();
    await first;
    await expect(client.importFromStaging(input)).rejects.toMatchObject({ code: 'BUSY' }); // target exists now
    const d = await client.driver(CAT, 'v', { mode: 'ro', create: false, role: 'validation' });
    await expect(client.unlink(CAT)).rejects.toMatchObject({ code: 'BUSY' });
    await d.close();
    await expect(client.unlink(CAT)).resolves.toBe(true);
    await expect(client.unlink(CAT)).resolves.toBe(false);
  });

  it('honours an already-aborted signal and an abort between chunks', async () => {
    const file = makeDbFile(2500);
    stage(file);
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file), signal: aborted.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const controller = new AbortController();
    await client.init();
    await client.__setFault({ chunkDelayMs: 5 });
    const run = client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT2, expectedBytes: file.length, expectedSha256: sha(file), signal: controller.signal, onProgress: () => controller.abort() });
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await client.listFiles()).not.toContain(CAT2);
  });

  it('a worker killed mid-import rejects WORKER_DIED and leaves other files intact', async () => {
    const file = makeDbFile(2500);
    stage(file);
    const user = await client.driver(USER, 'w', rw);
    await user.proxy('create table keep(a)', [], 'run');
    await user.proxy('insert into keep values (42)', [], 'run');
    await client.__setFault({ supplier: { kind: 'stall', afterBytes: 512 * 1024 } });
    const run = client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.__terminateWorker();
    await expect(run).rejects.toMatchObject({ code: 'WORKER_DIED' });
    await user.reopen?.();
    expect(await user.proxy('select a from keep', [], 'get')).toEqual({ rows: [42] });
  });

  it('USER statements interleave with the chunked import without corrupting either side', async () => {
    const file = makeDbFile(2500);
    stage(file);
    const user = await client.driver(USER, 'w', rw);
    await user.proxy('create table log(n integer)', [], 'run');
    await client.__setFault({ chunkDelayMs: 10 });
    let stop = false;
    let written = 0;
    const writer = (async () => {
      while (!stop) {
        await user.proxy('BEGIN IMMEDIATE', [], 'run');
        await user.proxy('insert into log values (?)', [written], 'run');
        await user.proxy('COMMIT', [], 'run');
        await user.afterCommit?.();
        written += 1;
      }
    })();
    const result = await client.importFromStaging({ source: { job: 'job12345', name: 'catalog.db.part' }, target: CAT, expectedBytes: file.length, expectedSha256: sha(file) });
    stop = true;
    await writer;
    expect(result.sha256).toBe(sha(file));
    expect(written).toBeGreaterThan(2);
    expect(await user.proxy('select count(*) from log', [], 'get')).toEqual({ rows: [written] });
    expect(await user.proxy('PRAGMA integrity_check', [], 'get')).toEqual({ rows: ['ok'] });
  });
});

describe('housekeeping', () => {
  it('ensureCapacity grows by awaited reserveMinimumCapacity and reports CAPACITY on failure; never deletes', async () => {
    await client.init();
    h.pool.files.set(USER, new Uint8Array(0));
    expect((await client.ensureCapacity(4)).capacity).toBeGreaterThanOrEqual(5);
    h.pool.capacity = 2;
    h.pool.failReserve = true;
    await expect(client.ensureCapacity(10)).rejects.toMatchObject({ code: expect.stringMatching(/CAPACITY|QUOTA/) });
    expect(h.pool.files.has(USER)).toBe(true);
  });

  it('stats report session, files, open paths and wasm memory where available', async () => {
    const d = await client.driver(USER, 'w', rw);
    await d.proxy('create table t(a)', [], 'run');
    const s = await client.stats();
    expect(s.sessionId).toBeTruthy();
    expect(s.files).toEqual([USER]);
    expect(s.openPaths).toEqual([{ path: USER, refs: 1, inTransaction: false }]);
    expect(s.wasmMemoryBytes === null || s.wasmMemoryBytes > 0).toBe(true);
  });

  it('shutdown drains, closes every path and later driver() starts a fresh session', async () => {
    const d = await client.driver(USER, 'w', rw);
    await d.proxy('create table t(a)', [], 'run');
    await client.shutdown();
    await expect(d.proxy('select 1', [], 'get')).rejects.toMatchObject({ code: 'STALE_SESSION' });
    expect((await client.stats()).sessionId).toBeNull();
    const again = await client.driver(USER, 'w', { mode: 'rw', create: false, role: 'user' });
    expect(await again.proxy('select count(*) from t', [], 'get')).toEqual({ rows: [0] });
    expect(h.cores).toHaveLength(2);
  });
});
