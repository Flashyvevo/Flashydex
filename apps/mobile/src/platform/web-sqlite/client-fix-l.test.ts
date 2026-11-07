// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createWebSqliteClient, type WorkerLike } from './client';
import { installPoolWithRetry, withPoolOpenRetry } from './pool-boot-retry';
import { PROTOCOL, type InitPayload, type RequestEnvelope, type WorkerMessage } from './protocol';

/** Fix-l: S8-02 (executor-aware deadlines) and S8-03 (hung pool acquisition = discard the worker). */
const USER = '/user/u-dddddd01.db';
const OTHER = '/user/u-dddddd02.db';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { sqliteVersion: '3', capacity: 16, fileCount: 0, wasmMemoryBytes: null, timings: { poolReadyMs: 1, probeMs: 1 } };
const OPENED = { dbId: 1, pragmas: {} };

type Script = (request: RequestEnvelope, post: (message: WorkerMessage) => void, worker: number, openIndex: number) => void;

function fakeWorkers(script: Script): { factory: () => WorkerLike; terminated: () => number; created: () => number } {
  let terminated = 0;
  let created = 0;
  let opens = 0;
  const factory = (): WorkerLike => {
    created += 1;
    const index = created;
    let dead = false;
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const post = (message: WorkerMessage) => { setTimeout(() => { if (!dead) for (const l of listeners) l({ data: message }); }, 0); };
    queueMicrotask(() => post({ kind: 'ready', protocol: PROTOCOL }));
    return {
      postMessage: (message) => {
        const request = message as RequestEnvelope;
        if (request.op === 'ping') {
          post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload: { pong: true }, timings: { execMs: 0 } });
          return;
        }
        if (request.op === 'open') opens += 1;
        script(request, post, index, opens);
      },
      terminate: () => { dead = true; terminated += 1; },
      addEventListener: ((type: string, l: (e: { data: unknown }) => void) => { if (type === 'message') listeners.push(l); }) as WorkerLike['addEventListener']
    };
  };
  return { factory, terminated: () => terminated, created: () => created };
}
const reply = (request: RequestEnvelope, payload: unknown): WorkerMessage => ({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: true, payload, timings: { execMs: 0 } });
const started = (request: RequestEnvelope): WorkerMessage => ({ kind: 'started', sessionId: request.sessionId, requestId: request.requestId });
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { code: string }).code);

describe('S8-02: executor-aware deadlines', () => {
  /** Worker: `exec` runs a long synchronous statement (heartbeats TAGGED with its request id), an `open` queued behind it only gets handled afterwards. */
  function busyThenOpen(options: { busyMs: number; tag: boolean }) {
    const queuedOpens: RequestEnvelope[] = [];
    let execId = 0;
    return fakeWorkers((request, post, _worker, openIndex) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open' && openIndex === 1) post(reply(request, OPENED)); // the first driver
      else if (request.op === 'exec') {
        execId = request.requestId;
        const beat = setInterval(() => post({ kind: 'heartbeat', sessionId: request.sessionId, ...(options.tag ? { requestId: execId } : {}) }), 15);
        setTimeout(() => {
          clearInterval(beat);
          post(reply(request, { rows: [[1]], inTransaction: false }));
          for (const queued of queuedOpens.splice(0)) { post(started(queued)); post(reply(queued, { dbId: 2, pragmas: {} })); }
        }, options.busyMs);
      } else if (request.op === 'open') queuedOpens.push(request); // single-threaded worker: handled only after the statement ends
    });
  }

  it('a queued open behind a progressing executor does not expire (far beyond 6x the window); both succeed, 0 terminations', async () => {
    const w = busyThenOpen({ busyMs: 900, tag: true });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    const busy = d.proxy('select long', [], 'values');
    await sleep(20);
    const queued = code(client.driver(OTHER, 'x', { mode: 'rw', create: true, role: 'user' }));
    await busy;
    expect(await queued).toBe('ok'); // 900 ms >> the old cap of 6 x 80 ms = 480 ms
    expect(w.terminated()).toBe(0);
    expect(w.created()).toBe(1);
  });

  it('untagged heartbeats keep the legacy cap: the same queued open dies (the cap was the S8-02 defect; tagging removes it)', async () => {
    const w = busyThenOpen({ busyMs: 900, tag: false });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    const d = await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    void d.proxy('select long', [], 'values').catch(() => undefined);
    await sleep(20);
    expect(await code(client.driver(OTHER, 'x', { mode: 'rw', create: true, role: 'user' }))).toBe('WORKER_DIED');
    expect(w.terminated()).toBe(1);
  });

  it('once an open has STARTED, other requests\' heartbeats no longer keep it alive; its own silence still kills the worker (WORKER_DIED / unknown, bounded)', async () => {
    const w = fakeWorkers((request, post, _worker, openIndex) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open' && openIndex === 1) post(reply(request, OPENED));
      else if (request.op === 'open') {
        post(started(request)); // executing now ... and then stalled in async acquisition with no progress of its own
        const beat = setInterval(() => post({ kind: 'heartbeat', sessionId: request.sessionId, requestId: request.requestId + 500 }), 15);
        setTimeout(() => clearInterval(beat), 1_000);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    const t0 = Date.now();
    const error = await client.driver(OTHER, 'x', { mode: 'rw', create: true, role: 'user' }).then(() => null, (e: unknown) => e as { code: string; details: { commitState?: string } });
    expect(error?.code).toBe('WORKER_DIED');
    expect(error?.details.commitState).toBe('unknown');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.terminated()).toBe(1);
  });

  it('the deadline of a request starts when it begins executing: `started` grants a fresh full window after a long queue wait', async () => {
    const w = fakeWorkers((request, post, _worker, openIndex) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open' && openIndex === 1) post(reply(request, OPENED));
      else if (request.op === 'open') {
        // queued ~120 ms (> the 80 ms window) behind tagged progress, then starts and answers 60 ms after starting
        const beat = setInterval(() => post({ kind: 'heartbeat', sessionId: request.sessionId, requestId: 99 }), 15);
        setTimeout(() => { clearInterval(beat); post(started(request)); setTimeout(() => post(reply(request, { dbId: 2, pragmas: {} })), 60); }, 120);
      }
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    expect(await code(client.driver(OTHER, 'x', { mode: 'rw', create: true, role: 'user' }))).toBe('ok');
    expect(w.terminated()).toBe(0);
  });

  it('a genuinely silent worker still dies: a queued open with no heartbeat and no start is killed at its window', async () => {
    const w = fakeWorkers((request, post, _worker, openIndex) => {
      if (request.op === 'init') post(reply(request, INIT));
      else if (request.op === 'open' && openIndex === 1) post(reply(request, OPENED));
      // the second open: total silence
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    await client.driver(USER, 'w', { mode: 'rw', create: true, role: 'user' });
    const t0 = Date.now();
    expect(await code(client.driver(OTHER, 'x', { mode: 'rw', create: true, role: 'user' }))).toBe('WORKER_DIED');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.terminated()).toBe(1);
  });

  it('a stalled init (started, then no progress) fails INIT_FAILED within the bound even while the worker answers pings', async () => {
    const w = fakeWorkers((request, post) => { if (request.op === 'init') post(started(request)); });
    const client = createWebSqliteClient({ workerFactory: w.factory, requestTimeoutMs: 80, livenessIntervalMs: 10, livenessTimeoutMs: 1_000 });
    const t0 = Date.now();
    expect(await code(client.init())).toBe('INIT_FAILED');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(w.terminated()).toBe(1);
  });
});

/* ───────────── S8-03 ───────────── */
/** The pinned initializer's cache (dist/index.mjs ~17228-17237): a PENDING promise stays the cached result; only a SETTLED REJECTION is replaced when `force` is passed. */
function cachingInstaller() {
  const state = { calls: 0, reserves: 0, rejectLate: null as (() => void) | null, resolveLate: null as (() => void) | null };
  let cached: { promise: Promise<{ reserveMinimumCapacity(n: number): Promise<number> }>; settled: 'pending' | 'ok' | 'rejected' } | null = null;
  const util = { reserveMinimumCapacity: async () => { state.reserves += 1; return 1; } };
  const install = (options: { forceReinitIfPreviouslyFailed?: true }, mode: () => 'hang' | 'ok' | 'reject-soon') => {
    state.calls += 1;
    if (cached && !(cached.settled === 'rejected' && options.forceReinitIfPreviouslyFailed)) return cached.promise;
    const entry = { settled: 'pending' as 'pending' | 'ok' | 'rejected', promise: null as unknown as Promise<typeof util> };
    const how = mode();
    entry.promise = new Promise<typeof util>((resolve, reject) => {
      if (how === 'ok') { entry.settled = 'ok'; resolve(util); }
      else if (how === 'reject-soon') setTimeout(() => { entry.settled = 'rejected'; reject(new Error('NoModificationAllowedError: The pool could not be opened (busy)')); }, 5);
      else { state.resolveLate = () => { entry.settled = 'ok'; resolve(util); }; state.rejectLate = () => { entry.settled = 'rejected'; reject(new Error('late failure')); }; }
    });
    cached = entry;
    return entry.promise;
  };
  return { state, install };
}
const base = { name: 'n', directory: '/d', initialCapacity: 6 };

describe('S8-03: hung pool acquisition (cache-faithful initializer model)', () => {
  it('a hung attempt is NOT retried in the same worker: one acquisition, PoolOpenFailure.hung, a late resolve never reserves', async () => {
    const c = cachingInstaller();
    const failure = await installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { attemptTimeoutMs: 20, random: () => 0.5, sleep: async () => undefined }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'PoolOpenFailure', hung: true });
    expect((failure as { attempts: { code: string }[] }).attempts).toHaveLength(1);
    expect((failure as { attempts: { code: string }[] }).attempts[0]?.code).toBe('INIT_FAILED');
    expect(c.state.calls).toBe(1); // a second call would just return the cached pending promise
    c.state.resolveLate!(); // the abandoned attempt completes after the fact
    await sleep(10);
    expect(c.state.reserves).toBe(0); // ... and is ignored: no second reservation caller in the pool
  });

  it('a late REJECT of an abandoned attempt is swallowed (no unhandled rejection) and still reports hung', async () => {
    const c = cachingInstaller();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const failure = await installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { attemptTimeoutMs: 15 }).catch((e: unknown) => e);
      expect(failure).toMatchObject({ hung: true });
      c.state.rejectLate!();
      await sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a SETTLED rejection (even a late one inside the bound) is retried in the SAME worker with the forced re-init and succeeds', async () => {
    const c = cachingInstaller();
    let call = 0;
    const out = await installPoolWithRetry((o) => c.install(o, () => (++call === 1 ? 'reject-soon' : 'ok')), base, { attemptTimeoutMs: 500, random: () => 0.5, sleep: async () => undefined });
    expect(out).toBeDefined();
    expect(c.state.calls).toBe(2);
    expect(c.state.reserves).toBe(1);
  });

  it('every attempt is clipped to the remaining total budget: a hung attempt cannot run 8 s past a 60 ms budget', async () => {
    const c = cachingInstaller();
    const t0 = Date.now();
    const failure = await installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { budgetMs: 60, attemptTimeoutMs: 8_000, random: () => 0.5 }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'PoolOpenFailure', hung: true, exhausted: true });
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('withPoolOpenRetry hands the attempt an abandoned() flag that flips once the attempt was given up', async () => {
    let flag: (() => boolean) | null = null;
    await withPoolOpenRetry((ctx) => { flag = ctx.abandoned; return new Promise<never>(() => undefined); }, { attemptTimeoutMs: 10 }).catch(() => undefined);
    expect(flag!()).toBe(true);
  });
});

describe('S8-03: the client supervises the boot (terminate + fresh worker for a hung acquisition)', () => {
  const hungError = (request: RequestEnvelope): WorkerMessage => ({
    kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, timings: { execMs: 0 },
    error: { code: 'INIT_FAILED', message: 'The browser storage pool could not be opened', retryable: true, commitState: 'not_started', hung: true, attempts: [{ attempt: 1, force: false, code: 'INIT_FAILED', cause: 'WebStorageError: The storage pool attempt did not finish in time', elapsedMs: 20 }] }
  });
  const fast = { startDelayMs: 2, capDelayMs: 4, random: () => 0.5 };

  it('hung first attempt -> that worker is terminated, a FRESH worker boots and succeeds with the clipped remaining budget; the abandoned worker\'s late reply is ignored', async () => {
    const payloads: InitPayload[] = [];
    const lateFromFirst: { post: (m: WorkerMessage) => void; request: RequestEnvelope }[] = [];
    const w = fakeWorkers((request, post, worker) => {
      if (request.op !== 'init') return;
      payloads.push(request.payload as InitPayload);
      if (worker === 1) { post(hungError(request)); lateFromFirst.push({ post, request }); } else post(reply(request, INIT));
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 5_000, bootAttemptTimeoutMs: 20, bootBackoff: fast });
    const info = await client.init();
    expect(info.sessionId).toBeTruthy();
    expect(w.created()).toBe(2);
    expect(w.terminated()).toBe(1); // exactly the hung worker
    lateFromFirst[0]!.post(reply(lateFromFirst[0]!.request, { ...INIT, capacity: 999 })); // late resolve on the abandoned worker: its worker is gone
    await sleep(15);
    expect((await client.init()).capacity).toBe(16);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.bootBudgetMs).toBeLessThanOrEqual(5_000);
    expect(payloads[1]?.bootBudgetMs).toBeLessThan(payloads[0]!.bootBudgetMs!); // clipped to what is left of the ONE total budget
    expect(payloads[1]?.bootAttemptTimeoutMs).toBe(20);
  });

  it('exhausted: every worker hangs -> INIT_FAILED with the merged attempts list, every worker terminated, never two live at once', async () => {
    let live = 0;
    let maxLive = 0;
    const w = fakeWorkers((request, post) => { if (request.op === 'init') post(hungError(request)); });
    const factory = (): WorkerLike => {
      live += 1;
      maxLive = Math.max(maxLive, live);
      const worker = w.factory();
      return { ...worker, terminate: () => { live -= 1; worker.terminate(); } };
    };
    const client = createWebSqliteClient({ workerFactory: factory, bootBudgetMs: 150, bootAttemptTimeoutMs: 20, bootBackoff: fast });
    const t0 = Date.now();
    const error = await client.init().then(() => null, (e: unknown) => e as { code: string; details: { attempts?: { attempt: number; elapsedMs: number }[]; retryable?: boolean } });
    expect(error?.code).toBe('INIT_FAILED');
    expect(error?.details.retryable).toBe(true);
    const attempts = error?.details.attempts ?? [];
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.map((a) => a.attempt)).toEqual(attempts.map((_, i) => i + 1));
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(w.terminated()).toBe(w.created());
    expect(maxLive).toBe(1);
  });

  it('a NON-hung INIT_FAILED (settled failure already retried inside the worker) is not restarted by the client', async () => {
    const w = fakeWorkers((request, post) => {
      if (request.op === 'init') post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, timings: { execMs: 0 }, error: { code: 'INIT_FAILED', message: 'x', retryable: false, commitState: 'not_started' } });
    });
    const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 5_000, bootBackoff: fast });
    expect(await code(client.init())).toBe('INIT_FAILED');
    expect(w.created()).toBe(1);
  });

  it('retirement during the backoff between workers stops the replacement', async () => {
    const w = fakeWorkers((request, post) => { if (request.op === 'init') post(hungError(request)); });
    const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 5_000, bootBackoff: { ...fast, sleep: async () => { client.retire(); } } });
    expect(await code(client.init())).toBe('RETIRED');
    expect(w.created()).toBe(1);
  });
});
