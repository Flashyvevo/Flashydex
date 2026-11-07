// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createWebSqliteClient, type WorkerLike } from './client';
import { installPoolWithRetry, remainingBootBudgetMs, withPoolOpenRetry } from './pool-boot-retry';
import { PROTOCOL, type InitPayload, type RequestEnvelope, type WorkerMessage } from './protocol';

/** Fix-l: S8-02 (executor-aware deadlines) and S8-03 (hung pool acquisition = discard the worker). */
const USER = '/user/u-dddddd01.db';
const OTHER = '/user/u-dddddd02.db';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INIT = { sqliteVersion: '3', capacity: 16, fileCount: 0, wasmMemoryBytes: null, timings: { poolReadyMs: 1, probeMs: 1 } };
const OPENED = { dbId: 1, pragmas: {} };

type Script = (request: RequestEnvelope, post: (message: WorkerMessage) => void, worker: number, openIndex: number) => void;

function fakeWorkers(script: Script, readyDelayMs = 0): { factory: () => WorkerLike; terminated: () => number; created: () => number } {
  let terminated = 0;
  let created = 0;
  let opens = 0;
  const factory = (): WorkerLike => {
    created += 1;
    const index = created;
    let dead = false;
    const listeners: ((e: { data: unknown }) => void)[] = [];
    const post = (message: WorkerMessage) => { setTimeout(() => { if (!dead) for (const l of listeners) l({ data: message }); }, 0); };
    if (readyDelayMs > 0) setTimeout(() => post({ kind: 'ready', protocol: PROTOCOL }), readyDelayMs);
    else queueMicrotask(() => post({ kind: 'ready', protocol: PROTOCOL }));
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

  it('every attempt is clipped to the remaining total budget: a hung attempt cannot run 8 s past a 60 ms budget (fake monotonic clock)', async () => {
    vi.useFakeTimers();
    try {
      const c = cachingInstaller();
      const pending = installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { budgetMs: 60, attemptTimeoutMs: 8_000, random: () => 0.5, now: () => Date.now() }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(59);
      expect(c.state.calls).toBe(1); // still inside the budget: the attempt is still pending, not given up on early
      await vi.advanceTimersByTimeAsync(1); // exactly the chosen budget
      const failure = await pending;
      expect(failure).toMatchObject({ name: 'PoolOpenFailure', hung: true, exhausted: true });
      expect((failure as { attempts: { elapsedMs: number }[] }).attempts[0]?.elapsedMs).toBe(60);
      expect(c.state.calls).toBe(1); // nothing was started after exhaustion
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhaustion is defined by the chosen budget, not the clock\'s fractional arrival: a clipped attempt that hangs is exhausted even if the monotonic clock reads 59.4 of 60', async () => {
    vi.useFakeTimers();
    try {
      const c = cachingInstaller();
      let clock = 0;
      const pending = installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { budgetMs: 60, attemptTimeoutMs: 8_000, now: () => clock }).catch((e: unknown) => e);
      clock = 59.4;
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toMatchObject({ hung: true, exhausted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hung attempt that used its OWN (shorter) limit inside a larger budget is hung but NOT exhausted', async () => {
    vi.useFakeTimers();
    try {
      const c = cachingInstaller();
      const pending = installPoolWithRetry((o) => c.install(o, () => 'hang'), base, { budgetMs: 1_000, attemptTimeoutMs: 20, now: () => Date.now() }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ hung: true, exhausted: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('S9-02: no acquisition is started once the budget is gone (worker-side remainder <= 0), and the worker subtracts its module/probe time', async () => {
    expect(remainingBootBudgetMs(undefined, 500)).toBeUndefined();
    expect(remainingBootBudgetMs(1_000, 300 + 150)).toBe(550);
    expect(remainingBootBudgetMs(1_000, 1_200)).toBeLessThanOrEqual(0);
    const c = cachingInstaller();
    const failure = await installPoolWithRetry((o) => c.install(o, () => 'ok'), base, { budgetMs: remainingBootBudgetMs(1_000, 1_200)! }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'PoolOpenFailure', exhausted: true });
    expect(c.state.calls).toBe(0);
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

/* ───────────── S9-02: ONE elapsed boot budget (fake clock) ───────────── */
describe('S9-02: the boot budget is ONE total elapsed budget across ready, module/probe, init and replacement workers', () => {
  const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;
  const fast = { startDelayMs: 2, capDelayMs: 4, random: () => 0.5 };
  const live = { livenessIntervalMs: 10, livenessTimeoutMs: 10_000_000 };
  const hung = (request: RequestEnvelope): WorkerMessage => ({
    kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, timings: { execMs: 0 },
    error: { code: 'INIT_FAILED', message: 'The browser storage pool could not be opened', retryable: true, commitState: 'not_started', hung: true, attempts: [{ attempt: 1, force: false, code: 'INIT_FAILED', cause: 'WebStorageError: hung', elapsedMs: 5 }] }
  });
  type Phase = { worker: number; phase: string; elapsedMs: number };
  type Failure = { code: string; details: { exhausted?: boolean; phases?: Phase[]; attempts?: { attempt: number }[]; elapsedMs?: number } } | null;
  const run = async (promise: Promise<unknown>, advanceMs: number): Promise<Failure> => {
    const outcome = promise.then(() => null, (e: unknown) => e as Failure);
    await vi.advanceTimersByTimeAsync(advanceMs);
    return outcome;
  };

  it('delayed ready: the remainder is measured AFTER ready, so init gets the budget minus the ready wait', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      const payloads: InitPayload[] = [];
      const w = fakeWorkers((request, post) => { if (request.op === 'init') { payloads.push(request.payload as InitPayload); post(reply(request, INIT)); } }, 50);
      const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 200, ...live });
      const done = client.init();
      await vi.advanceTimersByTimeAsync(60);
      await done;
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.bootBudgetMs).toBeLessThanOrEqual(150); // 200 - the 50 ms ready wait (it was 200 before S9-02)
      expect(payloads[0]!.bootBudgetMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ready slower than the whole budget: the ready wait is clipped, init is NEVER sent, final diagnostics carry the ready phase', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      let inits = 0;
      const w = fakeWorkers((request) => { if (request.op === 'init') inits += 1; }, 150);
      const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 80, ...live });
      const t0 = Date.now();
      const error = await run(client.init(), 200);
      expect(error?.code).toBe('INIT_FAILED');
      expect(error?.details.exhausted).toBe(true);
      expect(Date.now() - t0).toBeLessThanOrEqual(200); // the fake clock only moved to 200 because the test advanced it; elapsed below is the real measure
      expect(error?.details.elapsedMs).toBeLessThanOrEqual(81);
      expect(error?.details.phases).toEqual([{ worker: 1, phase: 'ready', elapsedMs: expect.any(Number) }]);
      expect(error?.details.phases![0]!.elapsedMs).toBeGreaterThanOrEqual(79);
      expect(inits).toBe(0);
      expect(w.terminated()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('slow module load / OPFS probe inside the worker: the worker subtracts it and refuses to start an acquisition; the client reports exhausted with the init phase', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      let acquisitions = 0;
      const w = fakeWorkers((request, post) => {
        if (request.op !== 'init') return;
        const budget = (request.payload as InitPayload).bootBudgetMs;
        // the worker model of sql.worker.ts boot(): 70 ms module + probe, then the SAME remainder rule
        setTimeout(() => {
          const left = remainingBootBudgetMs(budget, 70);
          if (left !== undefined && left <= 0) {
            post({ kind: 'response', protocol: PROTOCOL, sessionId: request.sessionId, requestId: request.requestId, ok: false, timings: { execMs: 0 }, error: { code: 'INIT_FAILED', message: 'The browser storage pool could not be opened', retryable: true, commitState: 'not_started', exhausted: true, moduleMs: 60, probeMs: 10 } });
          } else { acquisitions += 1; post(reply(request, INIT)); }
        }, 70);
      });
      const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 60, ...live });
      const error = await run(client.init(), 200);
      expect(error?.code).toBe('INIT_FAILED');
      expect(error?.details.exhausted).toBe(true);
      expect(acquisitions).toBe(0);
      const phases = error?.details.phases ?? [];
      expect(phases.map((p) => p.phase)).toEqual(['ready', 'init']);
      expect(phases[1]!.elapsedMs).toBeGreaterThanOrEqual(70);
      expect(w.created()).toBe(1); // a non-hung exhausted failure is not restarted
    } finally {
      vi.useRealTimers();
    }
  });

  it('replacement workers inherit the REMAINING budget (never a fresh one) and the final diagnostics show per-phase elapsed', async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      const payloads: InitPayload[] = [];
      const w = fakeWorkers((request, post) => { if (request.op === 'init') { payloads.push(request.payload as InitPayload); post(hung(request)); } }, 30);
      const client = createWebSqliteClient({ workerFactory: w.factory, bootBudgetMs: 100, bootAttemptTimeoutMs: 20, bootBackoff: fast, ...live });
      const error = await run(client.init(), 400);
      expect(error?.code).toBe('INIT_FAILED');
      expect(error?.details.exhausted).toBe(true);
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      payloads.forEach((p, i) => expect(p.bootBudgetMs!).toBeLessThanOrEqual(100 - 30 * (i + 1))); // each worker's ready wait already came off the one budget
      for (let i = 1; i < payloads.length; i += 1) expect(payloads[i]!.bootBudgetMs!).toBeLessThan(payloads[i - 1]!.bootBudgetMs!);
      const phases = error?.details.phases ?? [];
      // a worker whose ready wait ate the rest of the budget never gets an init (so ready phases may exceed init payloads by that one)
      const readies = phases.filter((p) => p.phase === 'ready').length;
      expect([payloads.length, payloads.length + 1]).toContain(readies);
      expect(phases.some((p) => p.phase === 'backoff')).toBe(true);
      for (const p of phases.filter((x) => x.phase === 'ready')) expect(p.elapsedMs).toBeGreaterThanOrEqual(30);
      expect(error?.details.elapsedMs).toBeLessThanOrEqual(100 + 10);
      expect(w.terminated()).toBe(w.created());
    } finally {
      vi.useRealTimers();
    }
  });
});
