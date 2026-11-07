import type { SqlDriver } from '@flashydex/core';
import { retiredError } from './write-gate';

/**
 * Whole-job lifetime registry (Sol S8-01). An install / uninstall / rollback / sync / restore is ONE job from its admission (core's
 * WorkCoordinator inserts the `work_admission` row) until its final USER receipt transaction has settled (the lease release). Role-store
 * IndexedDB transitions and the receipts live inside that window, so the update handoff must not give the writer lock away while a job
 * is alive: `retire()` fences admission, cancels what is still cancellable (no durable effect yet), then waits - bounded - for `settled`.
 *
 * Handles come from two places: `observeJobAdmission` (below) derives the lease boundary from the user driver's own SQL, which is the only
 * place that sees every coordinator-admitted job (frozen core), and `run()` wraps individual port operations (stage / activate / remove...)
 * so one that runs outside a lease (boot recovery) is still awaited.
 */
export type JobKind = 'install' | 'uninstall' | 'rollback' | 'sync' | 'restore' | 'operation';

export interface JobHandle {
  readonly id: number;
  readonly kind: JobKind;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  readonly settled: Promise<void>;
  /** The job already changed durable state (role pointer, files, receipt): aborting it can no longer mean "nothing happened". */
  readonly durable: boolean;
}

interface LiveJob extends JobHandle {
  durable: boolean;
  abort(): void;
  settle(): void;
}

export const JOB_SETTLE_TIMEOUT_MS = 20_000;

export interface JobRetireResult {
  settled: boolean;
  /** Jobs still alive when the wait ended (empty when settled). */
  remaining: JobHandle[];
  aborted: number;
}

export interface JobRegistry {
  /** Registers a job that lives until `settle()`. Throws RETIRED once the admission fence is up. */
  begin(kind: JobKind): { handle: JobHandle; settle(): void };
  /** Wraps one operation as a job. `fn` receives the job's signal (aborted by retire(), plus `options.signal` when given). */
  run<T>(kind: JobKind, fn: (signal: AbortSignal) => Promise<T>, options?: { signal?: AbortSignal; durable?: boolean }): Promise<T>;
  /** The currently running job's first durable effect happened (there is at most one coordinator lease at a time). */
  noteDurable(): void;
  /** Cancellers called by retire() for jobs of `kind` that are still before their first durable effect. Returns the unregister. */
  registerCanceller(kind: JobKind, cancel: () => void): () => void;
  /** Throws RETIRED when the admission fence is up (a NEW job must not start). */
  assertAdmissible(): void;
  readonly fenced: boolean;
  fence(): void;
  lift(): void;
  active(): JobHandle[];
  /** Fence admission, cancel cancellable pre-durable jobs, wait up to `timeoutMs` for every job to settle. The fence stays up. */
  retire(timeoutMs?: number): Promise<JobRetireResult>;
  /** Test seam. */
  reset(): void;
}

export function createJobRegistry(): JobRegistry {
  let fenced = false;
  let nextId = 1;
  const live = new Set<LiveJob>();
  const cancellers = new Map<JobKind, Set<() => void>>();
  const waiters = new Set<() => void>();
  const notify = () => { for (const w of [...waiters]) w(); };

  const create = (kind: JobKind, outer?: AbortSignal): LiveJob => {
    const controller = new AbortController();
    let resolve!: () => void;
    const settled = new Promise<void>((r) => { resolve = r; });
    const job: LiveJob = {
      id: nextId++, kind, startedAt: Date.now(), signal: controller.signal, settled, durable: false,
      abort: () => {
        controller.abort();
        for (const cancel of [...(cancellers.get(kind) ?? [])]) {
          try { cancel(); } catch { /* a failing canceller never blocks the handoff */ }
        }
      },
      settle: () => {
        if (!live.delete(job)) return;
        resolve();
        notify();
      }
    };
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
    live.add(job);
    return job;
  };

  const registry: JobRegistry = {
    get fenced() { return fenced; },
    fence() { fenced = true; },
    lift() { fenced = false; },
    assertAdmissible() { if (fenced) throw retiredError(); },
    active: () => [...live],
    begin(kind) {
      registry.assertAdmissible();
      const job = create(kind);
      return { handle: job, settle: job.settle };
    },
    async run(kind, fn, options) {
      // An operation of an ALREADY admitted job (a lease is alive) is part of that job and may finish after the fence;
      // a stand-alone operation must not start after it.
      if (fenced && live.size === 0) throw retiredError();
      const job = create(kind, options?.signal);
      if (options?.durable) { job.durable = true; registry.noteDurable(); }
      try {
        return await fn(job.signal);
      } finally {
        job.settle();
      }
    },
    noteDurable() {
      for (const job of live) job.durable = true;
    },
    registerCanceller(kind, cancel) {
      const set = cancellers.get(kind) ?? new Set<() => void>();
      set.add(cancel);
      cancellers.set(kind, set);
      return () => { set.delete(cancel); };
    },
    async retire(timeoutMs = JOB_SETTLE_TIMEOUT_MS) {
      fenced = true; // (a) synchronous: no new job from here on
      let aborted = 0;
      for (const job of [...live]) {
        // (b) cancellable and before its first durable effect -> abort; everything else is awaited, never interrupted
        if (!job.durable && (cancellers.get(job.kind)?.size ?? 0) > 0) { aborted++; job.abort(); }
      }
      if (live.size > 0) {
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); waiters.delete(check); resolve(); };
          const check = () => { if (live.size === 0) done(); };
          const timer = setTimeout(done, timeoutMs);
          waiters.add(check);
        });
      }
      return { settled: live.size === 0, remaining: [...live], aborted };
    },
    reset() {
      fenced = false;
      live.clear();
      cancellers.clear();
      waiters.clear();
    }
  };
  return registry;
}

/** The one registry of this page. */
export const jobRegistry: JobRegistry = createJobRegistry();

/* ──────────────── lease boundary observer ──────────────── */
const ADMIT_RE = /^\s*INSERT\s+INTO\s+"?work_admission"?/i;
const RELEASE_RE = /^\s*DELETE\s+FROM\s+"?work_admission"?/i;
const KINDS = new Set<string>(['install', 'uninstall', 'rollback', 'sync', 'restore']);

/**
 * Wraps the USER driver (innermost of the write gate) and derives core's WorkCoordinator lease boundary from its SQL: the INSERT into
 * `work_admission` registers the job (refused with RETIRED when the admission fence is up, so the lease row is never written; dropped if
 * that transaction rolls back); the DELETE that releases the lease, settled (committed or not - core swallows a failed release) = the
 * job's final USER transaction is done. Explicit delegation (the real driver is a class instance); only `proxy` is intercepted.
 */
export function observeJobAdmission(driver: SqlDriver, registry: JobRegistry = jobRegistry): SqlDriver {
  let pending: { settle(): void } | null = null; // registered by the INSERT, not yet committed
  let current: { settle(): void } | null = null; // admitted (INSERT committed), not yet released
  let release = false;
  const proxy: SqlDriver['proxy'] = async (sql, params, method) => {
    if (ADMIT_RE.test(sql)) {
      pending?.settle();
      const kind = String(params[0]);
      const begun = registry.begin(KINDS.has(kind) ? (kind as JobKind) : 'operation'); // throws RETIRED after the fence
      pending = begun;
      try {
        return await driver.proxy(sql, params, method);
      } catch (error) {
        begun.settle();
        if (pending === begun) pending = null;
        throw error;
      }
    }
    if (RELEASE_RE.test(sql)) release = true;
    const head = sql.trimStart().toUpperCase();
    const isCommit = head.startsWith('COMMIT') || head.startsWith('END');
    const isRollback = head.startsWith('ROLLBACK') && !/^ROLLBACK\s+TO\b/.test(head);
    if (!isCommit && !isRollback) return driver.proxy(sql, params, method);
    const wasPending = pending;
    const wasRelease = release;
    pending = null;
    release = false;
    let committed = false;
    try {
      const result = await driver.proxy(sql, params, method);
      committed = isCommit;
      return result;
    } finally {
      if (wasPending) {
        if (committed) {
          current?.settle();
          current = wasPending;
        } else {
          wasPending.settle(); // a rolled-back (or failed) admission never was a job
        }
      }
      if (wasRelease && current && current !== wasPending) {
        current.settle();
        current = null;
      }
    }
  };
  return {
    label: driver.label,
    proxy,
    afterCommit: driver.afterCommit ? () => driver.afterCommit!() : undefined,
    reopen: driver.reopen ? () => driver.reopen!() : undefined,
    close: () => driver.close()
  };
}
