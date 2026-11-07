// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { __resetPageRetiredForTests, retirePage } from '../web-storage/write-gate';
import { createWebSqliteClient, type WorkerLike } from './client';
import { installPoolWithRetry, POOL_BOOT_ATTEMPT_TIMEOUT_MS, withPoolOpenRetry } from './pool-boot-retry';
import { PROTOCOL, type RequestEnvelope, type WorkerMessage } from './protocol';

const USER = '/user/u-cccccc01.db';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { sqliteVersion: '3', capacity: 16, fileCount: 0, wasmMemoryBytes: null, timings: { poolReadyMs: 1, probeMs: 1 } };

type Script = (request: RequestEnvelope, post: (message: WorkerMessage) => void) => void;

/** A worker whose EVENT LOOP IS ALIVE: `ping` is always answered (STALE_SESSION error while `staleUntilInit`), everything else follows `script`. */
function liveWorker(script: Script, options: { pingReply?: 'pong' | 'stale' } = {}): { factory: () => WorkerLike; terminated: () => number; created: () => number; pings: () => number } {
  let terminated = 0;
  let created = 0;
  let pings = 0;
  const factory = (): WorkerLike => {
    created += 1;
    let dead = false;
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const post = (message: WorkerMessage) => { setTimeout(() => { if (!dead) for (const l of listeners) l({ data: message }); }, 0); };
    queueMicrotask(() => post({ kind: 'ready', protocol: PROTOCOL }));
    return {
      postMessage: (message) => {
        const request = message as RequestEnvelope;
        if (request.op === 'ping') {
          pings += 1;
          if (options.pingReply === 'stale') {
            post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, error: { code: 'STALE_SESSION', message: 'The storage session changed; reopen storage', retryable: false, commitState: 'not_started' }, timings: { execMs: 0 } });
          } else {
            post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload: { pong: true }, timings: { execMs: 0 } });
          }
          return;
        }
        script(request, post);
      },
      terminate: () => { dead = true; terminated += 1; },
      addEventListener: ((type: string, l: (e: { data: unknown }) => void) => { if (type === 'message') listeners.push(l); }) as WorkerLike['addEventListener']
    };
  };
  return { factory, terminated: () => terminated, created: () => created, pings: () => pings };
}

const reply = (request: RequestEnvelope, payload: unknown): WorkerMessage => ({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload, timings: { execMs: 0 } });
const progress = (request: RequestEnvelope): WorkerMessage => ({ kind: 'progress', sessionId: request.sessionId, requestId: request.requestId, bytes: 1 });

describe('S7-03: init/open/reopen have their OWN bounded deadline', () => {
  it.each(['pong', 'stale'] as const)('init that never settles while pings keep being answered (%s) -> INIT_FAILED at the deadline, worker terminated', async (pingReply) => {
    const w = liveWorker(() => undefined, { pingReply }); // init: silence
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    const started = Date.now();
    const outcome = await client.init().then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    expect(outcome).toBe('INIT_FAILED');
    expect(Date.now() - started).toBeLessThan(400); // would be unbounded when every ping reply renewed the deadline
    expect(w.pings()).toBeGreaterThan(3); // the pings really were flowing
    expect(w.terminated()).toBe(1);
  });

  it('a stuck open is not kept alive by OTHER requests replying (list / ping)', async () => {
    const w = liveWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'list') post(reply(request, { files: [] }));
      // open: silence
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.init();
    const open = client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' }).then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    const started = Date.now();
    const chatter = setInterval(() => { void client.listFiles(); }, 15);
    const outcome = await open;
    clearInterval(chatter);
    expect(outcome).toBe('WORKER_DIED');
    expect(Date.now() - started).toBeLessThan(400);
    expect(w.terminated()).toBe(1);
  });

  it('a legitimate long open that reports progress tagged with ITS request id survives far beyond the deadline', async () => {
    const w = liveWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') {
        let n = 0;
        const timer = setInterval(() => {
          post(progress(request));
          if (++n === 20) { clearInterval(timer); post(reply(request, { dbId: 1, pragmas: {} })); }
        }, 20);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    const started = Date.now();
    await expect(client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' })).resolves.toBeDefined();
    expect(Date.now() - started).toBeGreaterThan(300); // 4x the 80 ms deadline
    expect(w.terminated()).toBe(0);
  });

  it('progress tagged with ANOTHER request id does not extend the stuck init/open', async () => {
    const w = liveWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') {
        const timer = setInterval(() => post({ kind: 'progress', sessionId: request.sessionId, requestId: request.requestId + 100, bytes: 1 }), 15);
        setTimeout(() => clearInterval(timer), 600);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.init();
    const outcome = await client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' }).then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    expect(outcome).toBe('WORKER_DIED');
  });

  it('untagged heartbeats still keep a busy open alive, but only up to the hard cap (6 deadlines)', async () => {
    const w = liveWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') setInterval(() => post({ kind: 'heartbeat', sessionId: request.sessionId }), 15).unref();
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 60, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.init();
    const started = Date.now();
    const outcome = await client.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' }).then(() => 'ok', (e: unknown) => (e as { code: string }).code);
    const took = Date.now() - started;
    expect(outcome).toBe('WORKER_DIED');
    expect(took).toBeGreaterThan(300); // survived well past one 60 ms deadline ...
    expect(took).toBeLessThan(1_200); // ... but a heartbeat loop cannot hold it forever (cap = 6 x 60 ms + one deadline)
  });
});

describe('S7-03: pool boot retry bounds each attempt', () => {
  it('default per-attempt bound is 8 s', () => {
    expect(POOL_BOOT_ATTEMPT_TIMEOUT_MS).toBe(8_000);
  });

  // S8-03: the earlier versions of the next three tests modelled a NON-caching initializer (a second call returned a fresh promise).
  // The pinned initializer caches the pending promise, so a hung attempt cannot be retried in-worker: it fails `hung` and the CLIENT discards the worker.
  // The cache-faithful coverage (single acquisition, late resolve ignored, clipping, client-supervised fresh worker) lives in client-fix-l.test.ts.
  it('a hung single attempt is a transient INIT_FAILED record flagged `hung` (never retried in the same worker)', async () => {
    let calls = 0;
    const failure = await withPoolOpenRetry(
      () => { calls += 1; return new Promise<string>(() => undefined); },
      { attemptTimeoutMs: 20, random: () => 0.5, sleep: async () => undefined }
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'PoolOpenFailure', hung: true });
    expect(calls).toBe(1);
    expect((failure as { attempts: { code: string; force: boolean }[] }).attempts).toMatchObject([{ attempt: 1, force: false, code: 'INIT_FAILED' }]);
  });

  it('a hung attempt after settled failures reports every attempt, the hung one last (budget still enforced)', async () => {
    let t = 0;
    let call = 0;
    const failure = await withPoolOpenRetry(
      () => (++call < 3 ? Promise.reject(Object.assign(new Error('busy'), { name: 'NoModificationAllowedError' })) : new Promise<string>(() => undefined)),
      { attemptTimeoutMs: 10, budgetMs: 100_000, random: () => 0.5, now: () => t, sleep: async (ms) => { t += ms; } }
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'PoolOpenFailure', hung: true });
    const attempts = (failure as { attempts: { code: string; force: boolean }[] }).attempts;
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.force)).toEqual([false, true, true]);
    expect(attempts[2]?.code).toBe('INIT_FAILED');
  });

  it('installPoolWithRetry: a hung install is NOT re-issued (the cached pending promise cannot be replaced); the late resolve never reserves', async () => {
    const seen: (true | undefined)[] = [];
    let reserves = 0;
    let finish!: (u: { reserveMinimumCapacity: () => Promise<number> }) => void;
    const util = { reserveMinimumCapacity: async () => { reserves += 1; return 1; } };
    const failure = await installPoolWithRetry(
      (options) => { seen.push(options.forceReinitIfPreviouslyFailed); return new Promise<typeof util>((resolve) => { finish = resolve; }); },
      { name: 'n', directory: '/d', initialCapacity: 6 },
      { attemptTimeoutMs: 15, random: () => 0.5, sleep: async () => undefined }
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ hung: true });
    expect(seen).toEqual([undefined]);
    finish(util);
    await sleep(10);
    expect(reserves).toBe(0);
  });
});

describe('S7-01: a retired client never starts a worker, opens, reopens or imports again (RETIRED)', () => {
  const OPEN = { dbId: 1, pragmas: {} };
  const echo = (): Script => (request, post) => {
    if (request.op === 'init') post(reply(request, INIT));
    else if (request.op === 'open' || request.op === 'reopen') post(reply(request, OPEN));
    else if (request.op === 'list') post(reply(request, { files: [] }));
    else post(reply(request, { rows: [], inTransaction: false }));
  };
  const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code: string }).code);
  const CATALOG = '/catalog-en/g-aaaaaa01.db';

  it('before init: init / driver / listFiles / unlink / ensureCapacity / imports reject RETIRED and no Worker is constructed', async () => {
    const w = liveWorker(echo());
    const client = createWebSqliteClient({ workerFactory: w.factory });
    client.retire();
    expect(await code(client.init())).toBe('RETIRED');
    expect(await code(client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' }))).toBe('RETIRED');
    expect(await code(client.listFiles())).toBe('RETIRED');
    expect(await code(client.unlink(CATALOG))).toBe('RETIRED');
    expect(await code(client.ensureCapacity(1))).toBe('RETIRED');
    expect(await code(client.importFromStaging({ target: CATALOG, source: { job: 'j', name: 'n' }, expectedBytes: 10, expectedSha256: 'a'.repeat(64) } as never))).toBe('RETIRED');
    expect(await code(client.importBytes(USER, new Uint8Array(4), 'a'.repeat(64)))).toBe('RETIRED');
    expect(w.created()).toBe(0);
  });

  it('after a normal session: init() (cached), driver() for a NEW path and reopen() all reject RETIRED; the already-open handle keeps its transaction until closed', async () => {
    const w = liveWorker(echo());
    const client = createWebSqliteClient({ workerFactory: w.factory });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    client.retire();
    expect(await code(client.init())).toBe('RETIRED');
    expect(await code(client.driver('/user/u-cccccc02.db', 'x', { mode: 'ro', create: false, role: 'validation' }))).toBe('RETIRED');
    expect(await code(d.reopen!())).toBe('RETIRED');
    await expect(d.proxy('select 1', [], 'values')).resolves.toEqual({ rows: [] }); // live handle: an admitted transaction can still finish
    await client.closePath(USER, { drain: true });
    await client.shutdown();
    expect(await code(client.init())).toBe('RETIRED'); // even after shutdown cleared the cached session
    expect(w.created()).toBe(1);
  });

  it('a call ALREADY awaiting init: retired while the worker boots -> RETIRED, the worker is torn down and never asked to acquire the pool', async () => {
    const requests: RequestEnvelope[] = [];
    const w = liveWorker((request) => { requests.push(request); });
    const client = createWebSqliteClient({ workerFactory: w.factory, readyTimeoutMs: 1_000 });
    const pending = code(client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' }));
    client.retire(); // worker constructed, 'ready' not delivered yet (it arrives on the next tick)
    expect(await pending).toBe('RETIRED');
    expect(requests.filter((r) => r.op === 'init')).toEqual([]);
    expect(w.terminated()).toBe(1);
  });

  it('a call ALREADY awaiting init: retired while the pool is being acquired -> RETIRED, session discarded', async () => {
    let held: { request: RequestEnvelope; post: (m: WorkerMessage) => void } | null = null;
    const w = liveWorker((request, post) => { if (request.op === 'init') held = { request, post }; });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 5_000 });
    const pending = code(client.init());
    await sleep(30);
    client.retire();
    held!.post(reply(held!.request, INIT));
    expect(await pending).toBe('RETIRED');
    expect(w.terminated()).toBe(1);
  });

  it('a call ALREADY awaiting the open reply: retired meanwhile -> the handle the worker opened is closed and RETIRED is thrown', async () => {
    const seen: RequestEnvelope[] = [];
    let held: { request: RequestEnvelope; post: (m: WorkerMessage) => void } | null = null;
    const w = liveWorker((request, post) => {
      seen.push(request);
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') held = { request, post };
      else post(reply(request, {}));
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 5_000 });
    await client.init();
    const pending = code(client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' }));
    await sleep(30);
    client.retire();
    held!.post(reply(held!.request, { dbId: 7, pragmas: {} }));
    expect(await pending).toBe('RETIRED');
    await sleep(10);
    expect(seen.some((r) => r.op === 'close' && r.dbId === 7)).toBe(true);
  });

  it('a delayed reopen already queued behind a running statement is refused when it finally runs', async () => {
    let releaseExec: (() => void) | null = null;
    const w = liveWorker((request, post) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open') post(reply(request, OPEN));
      else if (request.op === 'exec') releaseExec = () => post(reply(request, { rows: [], inTransaction: false }));
      else post(reply(request, OPEN));
    });
    const client = createWebSqliteClient({ workerFactory: w.factory });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    const running = d.proxy('select 1', [], 'values');
    await sleep(20);
    const queuedReopen = code(d.reopen!());
    await sleep(10);
    client.retire();
    releaseExec!();
    await running;
    expect(await queuedReopen).toBe('RETIRED');
  });

  it('the page-wide fence (retirePage) retires a client that already exists AND one created later', async () => {
    const w = liveWorker(echo());
    const before = createWebSqliteClient({ workerFactory: w.factory });
    await before.init();
    retirePage();
    try {
      const after = createWebSqliteClient({ workerFactory: w.factory });
      expect(await code(before.init())).toBe('RETIRED');
      expect(await code(after.driver(USER, 'w', { mode: 'ro', create: false, role: 'validation' }))).toBe('RETIRED');
      expect(w.created()).toBe(1);
    } finally {
      __resetPageRetiredForTests();
    }
  });
});
