import { useEffect, useId, useRef, useSyncExternalStore } from 'react';

/**
 * Update handoff coordination (WEB-STORAGE §7, W13). Tiny module-level store so any form can register dirtiness and any
 * long job (install / import / restore) can register itself without prop drilling.
 */
const dirty = new Set<string>();
const busy = new Map<string, string>();
const cancels = new Map<string, () => void>();
let nextJobId = 1;
const listeners = new Set<() => void>();
let writesBlocked = false;

const emit = () => { listeners.forEach((l) => l()); };

export function setWritesBlockedForHandoff(on: boolean): void {
  writesBlocked = on;
  emit();
}
export const isHandoffBlocked = (): boolean => writesBlocked;
export const hasDirtyForms = (): boolean => dirty.size > 0;
/** Message of the first running job that forbids an update restart, or null. */
export const busyReason = (): string | null => busy.values().next().value ?? null;

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function useWritesBlockedForHandoff(): boolean {
  return useSyncExternalStore(subscribe, () => writesBlocked, () => false);
}

/** A form calls this with its dirty flag; while true, an update restart asks to discard first. */
export function useReportDirty(isDirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!isDirty) return;
    dirty.add(id);
    emit();
    return () => { dirty.delete(id); emit(); };
  }, [isDirty, id]);
}

/** A long-running job (catalog download, import, restore, migration) registers while active. */
export function useReportBusy(active: boolean, message: string): void {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    busy.set(id, message);
    emit();
    return () => { busy.delete(id); emit(); };
  }, [active, message, id]);
}

/**
 * S7-01: a background job that keeps working on its own (network refresh, sync) registers here with the SAME busy registry (so an update
 * restart waits for it) plus a `cancel` the retirement calls (abort signal / service cancel) before it closes storage. `cancel` must be
 * idempotent and must not throw; the job unregisters (effect cleanup) once it really stopped.
 */
export function useReportBackgroundJob(active: boolean, message: string, cancel: () => void): void {
  const id = useId();
  const cancelRef = useRef(cancel);
  useEffect(() => { cancelRef.current = cancel; });
  useEffect(() => {
    if (!active) return;
    busy.set(id, message);
    cancels.set(id, () => cancelRef.current());
    emit();
    return () => { busy.delete(id); cancels.delete(id); emit(); };
  }, [active, message, id]);
}

/** Non-hook registration for jobs outside React (tests, services). Returns the unregister function. */
export function registerBackgroundJob(message: string, cancel: () => void): () => void {
  const id = `job-${nextJobId++}`;
  busy.set(id, message);
  cancels.set(id, cancel);
  emit();
  return () => { busy.delete(id); cancels.delete(id); emit(); };
}

/**
 * Retirement step: ask every registered background job to cancel, then wait (bounded) until none is registered any more. Resolves true when
 * quiet, false on timeout (the storage fence is already up, so a straggler's next storage call rejects RETIRED rather than reopening anything).
 */
export function quiesceBackgroundJobs(timeoutMs: number): Promise<boolean> {
  for (const cancel of [...cancels.values()]) {
    try { cancel(); } catch { /* a failing cancel must not block the handoff */ }
  }
  if (busy.size === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => { clearTimeout(timer); listeners.delete(check); resolve(value); };
    const check = () => { if (busy.size === 0) done(true); };
    const timer = setTimeout(() => done(busy.size === 0), timeoutMs);
    listeners.add(check);
  });
}

/* ──────────────── terminal storage retirement (S7-01) ──────────────── */

export interface RetireStorageOptions {
  /** Cancel + wait for background jobs (bounded). Runs AFTER the fence is up, BEFORE anything is closed. */
  quiesce?: () => Promise<unknown>;
  /** Wraps one close step with a timeout / error message (handoff passes its HandoffError timeout). */
  step?: <T>(promise: Promise<T>, what: string) => Promise<T>;
  /** How long to wait for admitted install/uninstall/rollback/sync/restore jobs to settle before giving up (S8-01). */
  jobSettleMs?: number;
}
let registeredRetirement: ((options: RetireStorageOptions) => Promise<void>) | null = null;
/** app-database.ts registers its `retireStorage` here at load, so handoff.ts needs no import of the storage layer. Returns an unregister (tests). */
export function registerStorageRetirement(fn: (options: RetireStorageOptions) => Promise<void>): () => void {
  registeredRetirement = fn;
  return () => { if (registeredRetirement === fn) registeredRetirement = null; };
}

/**
 * S8-01 job-lifetime fence. `settle(ms)` raises the admission fence (no NEW job can start), cancels what is still cancellable, and resolves
 * true once every admitted job has fully settled (final USER receipt + role transitions included), false when `ms` elapsed first. The SQL
 * write gate is deliberately still OPEN while it waits, so the admitted job finishes under this page's ownership. `lift()` takes the
 * admission fence down again after a recoverable refusal.
 */
export interface JobFence {
  settle(timeoutMs: number): Promise<boolean>;
  lift(): void;
}
let registeredJobFence: JobFence | null = null;
export function registerJobFence(fence: JobFence): () => void {
  registeredJobFence = fence;
  return () => { if (registeredJobFence === fence) registeredJobFence = null; };
}

/* ──────────────── update handoff controller (S5-04) ──────────────── */

export type HandoffFailure = { message: string; /** the app is still usable (gate reopened) */ recoverable: boolean; offerReload: boolean };
export type HandoffUiState = { phase: 'idle' | 'saving' | 'failed'; failure: HandoffFailure | null };

let ui: HandoffUiState = { phase: 'idle', failure: null };
const setUi = (next: HandoffUiState) => { ui = next; emit(); };
export const getHandoffUi = (): HandoffUiState => ui;
export function useHandoffUi(): HandoffUiState {
  return useSyncExternalStore(subscribe, () => ui, () => ui);
}
/** "Restart later" / "Keep using FlashyDex": back to normal. Only meaningful for a recoverable failure. */
/** Back to idle unconditionally (tests / a fresh page). */
export const resetHandoffUi = (): void => { committed = false; setUi({ phase: 'idle', failure: null }); };
/**
 * Set at the point of no return of a handoff and never cleared on a real page (only `resetHandoffUi`, for tests/fresh pages): from then on
 * this page's admissions are permanently invalid - the app wraps the write gate so `open()` is ignored - and the only way forward is a reload.
 */
let committed = false;
export const isHandoffCommitted = (): boolean => committed;
export function dismissHandoffFailure(): void {
  if (ui.phase === 'failed' && ui.failure?.recoverable) setUi({ phase: 'idle', failure: null });
}

export const HANDOFF_DRAIN_TIMEOUT_MS = 10_000;
export const HANDOFF_CLOSE_TIMEOUT_MS = 10_000;
/** How long the retirement waits for cancelled background jobs (sync / network refresh) to unregister. */
export const HANDOFF_JOB_QUIESCE_MS = 3_000;
/** How long the handoff waits for an admitted catalog/sync/restore job to finish (cancelling it when it still can) before it gives up and keeps the lock. */
export const HANDOFF_JOB_SETTLE_MS = 20_000;
const JOB_PENDING_TEXT = 'An update is still finishing. Reload when it’s done, or choose Restart later and try again.';

export interface HandoffDeps {
  /** Job-lifetime fence (S8-01). When omitted, the registered one is used; none registered = no job tracking (unit tests / native). */
  jobFence?: JobFence;
  jobSettleMs?: number;
  /** The page's write gate (web-storage/write-gate.ts). */
  gate: { close(): void; open(): void; drain(timeoutMs: number): Promise<boolean> };
  /** Open pool paths of the SQL client (empty off web). */
  listOpenPaths(): Promise<string[]>;
  /** WebSqliteClient.closePath with the fix-i drain option: waits for the owner's transaction, empties the queue, then closes. */
  closePath(path: string, options: { drain: true }): Promise<void>;
  /** Terminate the SQL worker after every path is closed. */
  shutdownClient(): Promise<void>;
  /** Release the origin-wide writer lock when this page can (no-op otherwise: the unload releases it). */
  releaseWriterLock?(): Promise<unknown> | unknown;
  /** A catalog install / restore / import / sync is running right now. */
  busyReason(): string | null;
  setBlocked(on: boolean): void;
  /** Terminal retirement (app-database `retireStorage`). When omitted, the registered one is used; when none is registered the close deps above run. */
  retireStorage?(options: RetireStorageOptions): Promise<void>;
  jobQuiesceMs?: number;
  drainTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HandoffError(`${what} took too long.`, true, true)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

export class HandoffError extends Error {
  constructor(message: string, readonly recoverable: boolean, readonly offerReload: boolean) {
    super(message);
    this.name = 'HandoffError';
  }
}

const BUSY_TEXT = (reason: string) => `${reason} FlashyDex can restart for the update once it finishes. Restart later, or wait and try again.`;

/**
 * The `prepare` step handed to `updateController.applyUpdate`. Order (S5-04): (1) refuse when a job is running, (2) close the write gate
 * (new service mutations reject MAINTENANCE), (3) await the drain of admitted transactions / in-flight driver calls, (4) close every open
 * pool path with drain, (5) shut the worker down, (6) release the writer lock. Failure before (4) reopens the gate: the app stays usable.
 * Throws HandoffError; the caller (runUpdateHandoff) records it in the UI state.
 */
export async function prepareUpdateHandoff(deps: HandoffDeps): Promise<void> {
  const early = deps.busyReason();
  if (early) throw new HandoffError(BUSY_TEXT(early), true, false);
  deps.setBlocked(true);
  const jobFence = deps.jobFence ?? registeredJobFence;
  if (jobFence) {
    // S8-01: BEFORE the write gate closes. An admitted install/uninstall/rollback/sync/restore must reach its final USER receipt (a transaction
    // the closed gate would refuse) and its role-store transitions while this page still owns the writer lock; new jobs are refused (RETIRED).
    let settled: boolean;
    try {
      settled = await jobFence.settle(deps.jobSettleMs ?? HANDOFF_JOB_SETTLE_MS);
    } catch {
      settled = false;
    }
    if (!settled) {
      jobFence.lift(); // nothing was retired: the app stays usable, the lock stays held (unload releases it)
      deps.setBlocked(false);
      throw new HandoffError(JOB_PENDING_TEXT, true, true);
    }
  }
  deps.gate.close();
  try {
    const drained = await deps.gate.drain(deps.drainTimeoutMs ?? HANDOFF_DRAIN_TIMEOUT_MS);
    if (!drained) throw new HandoffError('FlashyDex is still saving something and it is taking too long.', true, true);
    const late = deps.busyReason(); // a job that registered while the gate was closing
    if (late) throw new HandoffError(BUSY_TEXT(late), true, false);
  } catch (error) {
    deps.gate.open();
    jobFence?.lift();
    deps.setBlocked(false);
    throw error;
  }
  // Point of no return: the gate stays closed (permanently - see isHandoffCommitted); a failure from here on needs a reload to get a working storage layer back.
  committed = true;
  try {
    const closeMs = deps.closeTimeoutMs ?? HANDOFF_CLOSE_TIMEOUT_MS;
    const quiesce = () => quiesceBackgroundJobs(deps.jobQuiesceMs ?? HANDOFF_JOB_QUIESCE_MS);
    const retire = deps.retireStorage ?? registeredRetirement;
    if (retire) {
      // S7-01: ONE terminal retirement = fence (sync, before any await) -> quiesce jobs -> close every path -> terminate worker -> release the lock.
      await retire({ quiesce, step: (promise, what) => withTimeout(promise, closeMs, what) });
    } else {
      await quiesce(); // no storage layer registered (unit tests / native): still cancel + wait for background jobs
      for (const path of await deps.listOpenPaths()) await withTimeout(deps.closePath(path, { drain: true }), closeMs, 'Closing your collection');
      await withTimeout(deps.shutdownClient(), closeMs, 'Stopping storage');
      // Only now - every handle closed, worker terminated, admissions permanently invalid - may another tab become the writer.
      // A failure above deliberately does NOT release: a worker may still hold handles, so the lock stays until the reload.
      await deps.releaseWriterLock?.();
    }
  } catch (error) {
    throw error instanceof HandoffError ? new HandoffError(error.message, false, true) : new HandoffError('Storage could not be closed cleanly.', false, true);
  }
}

/**
 * Whole restart-for-update flow. `activate` is `updateController.applyUpdate` (or a DEV stand-in). Every path leaves the app usable or
 * shows an explicit failure: refused/timeout -> gate reopened + "Restart later"; storage already shut down but the new worker never
 * activated (`getUpdateError()` set, applyUpdate resolved) -> failure with a Reload button (reload restarts storage).
 */
export async function runUpdateHandoff(deps: HandoffDeps, activate: (prepare: () => Promise<void>) => Promise<void>, getUpdateError: () => string | null): Promise<void> {
  if (ui.phase === 'saving') return;
  setUi({ phase: 'saving', failure: null });
  let prepared = false;
  const out: { failure: HandoffFailure | null } = { failure: null };
  try {
    await activate(async () => {
      try {
        await prepareUpdateHandoff(deps);
      } catch (error) {
        const e = error instanceof HandoffError ? error : new HandoffError('The update didn’t start. Nothing changed.', true, false);
        out.failure = { message: e.message, recoverable: e.recoverable, offerReload: e.offerReload };
        throw e;
      }
      prepared = true;
    });
  } catch {
    out.failure ??= { message: 'The update didn’t start.', recoverable: !prepared, offerReload: true };
  }
  if (!out.failure && prepared) {
    // applyUpdate resolves normally when no worker was waiting or activation timed out: the page is NOT reloading and its storage is closed.
    const updateError = getUpdateError();
    if (updateError) out.failure = { message: `${updateError}. FlashyDex needs a quick reload to finish.`, recoverable: false, offerReload: true };
  }
  if (out.failure) {
    const failure = out.failure;
    if (!failure.recoverable) deps.setBlocked(true); // storage is closed: keep the UI blocked behind the failure card
    setUi({ phase: 'failed', failure });
  } else if (!prepared) {
    setUi({ phase: 'idle', failure: null });
  }
  // success: the controller reloads the page; the overlay stays up until then
}
