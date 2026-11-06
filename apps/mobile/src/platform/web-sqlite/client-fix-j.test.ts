// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSqliteClient, type WorkerLike } from './client';
import { PROTOCOL, type RequestEnvelope, type WorkerMessage } from './protocol';
import { createMemoryHarness } from './testing/memory-env';

/** Fix-j S6-01: proof of life must not depend on the worker's event loop (progress heartbeats), and deadlines are silence-based + visibility-aware. */
const USER = '/user/u-bbbbbb01.db';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(() => { vi.unstubAllGlobals(); });

describe('S6-01 worker side: heartbeat from INSIDE a synchronous statement', () => {
  it('PRAGMA integrity_check and a long recursive SELECT post heartbeats while stepping (progress handler), without interrupting the statement', async () => {
    const h = await createMemoryHarness();
    h.coreOptions = { progressOps: 500, heartbeatMs: 0 };
    const client = createWebSqliteClient({ workerFactory: h.workerFactory });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    await d.proxy('create table t(id integer primary key, v text)', [], 'run');
    await d.proxy('with recursive c(x) as (select 1 union all select x+1 from c where x<3000) insert into t(v) select hex(randomblob(200)) from c', [], 'run');
    h.posted = {};
    const check = await d.proxy('PRAGMA integrity_check', [], 'values');
    expect(check.rows).toEqual([['ok']]);
    const afterIntegrity = h.posted.heartbeat ?? 0;
    expect(afterIntegrity).toBeGreaterThan(0);
    h.posted = {};
    const sum = await d.proxy('with recursive c(x) as (select 1 union all select x+1 from c where x<200000) select sum(x) from c', [], 'values');
    expect(sum.rows).toEqual([[20000100000]]);
    expect(h.posted.heartbeat ?? 0).toBeGreaterThan(0);
    await client.shutdown();
  });

  it('heartbeats are throttled (heartbeatMs) and carry only the session id', async () => {
    const h = await createMemoryHarness();
    h.coreOptions = { progressOps: 100, heartbeatMs: 60_000 };
    const client = createWebSqliteClient({ workerFactory: h.workerFactory });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    h.posted = {};
    await d.proxy('with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select sum(x) from c', [], 'values');
    expect(h.posted.heartbeat).toBe(1);
    await client.shutdown();
  });
});

type Script = (request: RequestEnvelope, post: (message: WorkerMessage) => void) => void;

/** A worker that follows `script` and NEVER answers pings (a worker stuck in synchronous SQL cannot). */
function scriptedWorker(script: Script): { factory: () => WorkerLike; terminated: () => number } {
  let terminated = 0;
  const factory = (): WorkerLike => {
    let dead = false;
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const post = (message: WorkerMessage) => { setTimeout(() => { if (!dead) for (const l of listeners) l({ data: message }); }, 0); };
    queueMicrotask(() => post({ kind: 'ready', protocol: PROTOCOL }));
    return {
      postMessage: (message) => {
        const request = message as RequestEnvelope;
        if (request.op === 'ping') return;
        script(request, post);
      },
      terminate: () => { dead = true; terminated += 1; },
      addEventListener: ((type: string, l: (e: { data: unknown }) => void) => { if (type === 'message') listeners.push(l); }) as WorkerLike['addEventListener']
    };
  };
  return { factory, terminated: () => terminated };
}

const reply = (request: RequestEnvelope, payload: unknown): WorkerMessage => ({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload, timings: { execMs: 0 } });
const heartbeat = (request: RequestEnvelope): WorkerMessage => ({ kind: 'heartbeat', sessionId: request.sessionId });
const INIT = { sqliteVersion: '3', capacity: 16, fileCount: 0, wasmMemoryBytes: null, timings: { poolReadyMs: 1, probeMs: 1 } };

describe('S6-01 client side: liveness and deadlines are silence-based', () => {
  it('a worker that cannot answer pings but keeps sending heartbeats survives far beyond livenessTimeoutMs; the SQL result arrives and nothing was terminated', async () => {
    const w = scriptedWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') post(reply(request, { dbId: 1, pragmas: {} }));
      else if (request.op === 'exec') {
        let beats = 0;
        const timer = setInterval(() => {
          post(heartbeat(request));
          if (++beats === 20) { clearInterval(timer); post(reply(request, { rows: [[42]], inTransaction: false })); }
        }, 20);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, livenessIntervalMs: 10, livenessTimeoutMs: 60 });
    const d = await client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' });
    const started = Date.now();
    expect(await d.proxy('select 42', [], 'values')).toEqual({ rows: [[42]] });
    expect(Date.now() - started).toBeGreaterThan(300); // 5x the 60 ms window, zero pings answered
    expect(w.terminated()).toBe(0);
  });

  it('a truly dead worker (no reply, no ping, no heartbeat) is still declared dead', async () => {
    const w = scriptedWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') post(reply(request, { dbId: 1, pragmas: {} }));
      // exec: silence
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, livenessIntervalMs: 10, livenessTimeoutMs: 60 });
    const d = await client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' });
    await expect(d.proxy('select 42', [], 'values')).rejects.toMatchObject({ code: 'WORKER_DIED', details: { commitState: 'unknown' } });
    expect(w.terminated()).toBe(1);
  });

  it('heartbeats arriving while an open is pending extend its deadline (a busy worker, e.g. validating another file), but silence still kills it', async () => {
    let silent = false;
    const w = scriptedWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open' && !silent) {
        let beats = 0;
        const timer = setInterval(() => {
          post(heartbeat(request));
          if (++beats === 15) { clearInterval(timer); post(reply(request, { dbId: 1, pragmas: {} })); }
        }, 20);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80 });
    await expect(client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' })).resolves.toBeDefined(); // 300 ms > 80 ms deadline
    expect(w.terminated()).toBe(0);
    silent = true;
    await expect(client.driver('/user/u-bbbbbb02.db', 'x', { mode: 'ro', create: false, role: 'validation' })).rejects.toMatchObject({ code: 'WORKER_DIED' });
    expect(w.terminated()).toBe(1);
  });
});

describe('S6-01: hidden pages suspend ALL deadlines (init, open, reopen)', () => {
  function stubDocument(initial: 'hidden' | 'visible') {
    const handlers: (() => void)[] = [];
    const doc = { visibilityState: initial, addEventListener: (_: string, h: () => void) => { handlers.push(h); } };
    vi.stubGlobal('document', doc);
    return { set: (state: 'hidden' | 'visible') => { doc.visibilityState = state; for (const h of handlers) h(); } };
  }

  it('init: no INIT_FAILED while hidden; the deadline restarts when visible; an answer while hidden still completes', async () => {
    const page = stubDocument('hidden');
    let answerInit = false;
    let pendingInit: RequestEnvelope | null = null;
    let post: ((m: WorkerMessage) => void) | null = null;
    const w = scriptedWorker((request, p) => { post = p; if (request.op === 'init') { if (answerInit) p(reply(request, INIT)); else pendingInit = request; } });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 40 });
    let settled: string | null = null;
    const init = client.init().then(() => { settled = 'ok'; }, (e: unknown) => { settled = (e as { code: string }).code; });
    await sleep(250); // 6x the deadline, page hidden
    expect(settled).toBeNull();
    expect(w.terminated()).toBe(0);
    // answered while still hidden (throttled worker finally ran): completes, nothing was killed
    post!(reply(pendingInit!, INIT));
    await init;
    expect(settled).toBe('ok');
    expect(w.terminated()).toBe(0);
    void page;
    answerInit = false;
  });

  it('init: still silent after the page becomes visible -> INIT_FAILED after one full deadline', async () => {
    const page = stubDocument('hidden');
    const w = scriptedWorker(() => undefined);
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 50 });
    let settled: string | null = null;
    const init = client.init().catch((e: unknown) => { settled = (e as { code: string }).code; });
    await sleep(150);
    expect(settled).toBeNull();
    const shownAt = Date.now();
    page.set('visible');
    await sleep(20);
    expect(settled).toBeNull(); // restarted in FULL, not already expired
    await init;
    expect(settled).toBe('INIT_FAILED');
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(45);
  });

  it('open and reopen: a hidden page never kills the worker over a pending open/reopen', async () => {
    const page = stubDocument('visible');
    const requests: RequestEnvelope[] = [];
    let post: ((m: WorkerMessage) => void) | null = null;
    let hold = false;
    const w = scriptedWorker((request, p) => {
      post = p;
      requests.push(request);
      if (request.op === 'init') p(reply(request, INIT));
      else if (request.op === 'open' && !hold) p(reply(request, { dbId: 1, pragmas: {} }));
      else if (request.op === 'reopen' && !hold) p(reply(request, { dbId: 1, pragmas: {} }));
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 40 });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    hold = true;
    page.set('hidden');
    const reopen = d.reopen!().then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    const open = client.driver('/user/u-bbbbbb03.db', 'x', { mode: 'ro', create: false, role: 'validation' }).then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    await sleep(200);
    expect(w.terminated()).toBe(0);
    for (const r of requests.filter((q) => q.op === 'reopen' || (q.op === 'open' && q !== requests[1]))) post!(reply(r, { dbId: r.op === 'open' ? 2 : 1, pragmas: {} }));
    expect(await reopen).toBe('ok');
    expect(await open).toBe('ok');
    expect(w.terminated()).toBe(0);
  });
});
