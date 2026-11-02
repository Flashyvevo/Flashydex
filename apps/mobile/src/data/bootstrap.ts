import { createServices, timed, toDomainError, type DomainError, type Environment, type Services } from '@flashydex/core';
import { platform } from '../platform/app-platform';
import { catalogSource, createInstallPort, createUserDriver } from '../platform/app-database';
import { catalogConfig } from '../platform/catalog-config';
import { acquireInstanceLock } from '../platform/instance-lock';
import { uuidV4 } from '../lib/uuid';
import { prepareStorage, withMetricsRecording } from '../lib/storage-bridge';
import { setStartupProgress } from './startup-progress';

export const appEnvironment: Environment = {
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => uuidV4() }
};

/** Another page holds the origin-wide writer lock; storage was deliberately NOT opened. */
export class InstanceLockedError extends Error {
  readonly code = 'INSTANCE_LOCK';
  constructor() {
    super('FlashyDex is open in another tab');
    this.name = 'InstanceLockedError';
  }
}

/** `navigator.locks` is missing (insecure origin / old browser): the browser cannot guarantee one writer, so storage is NOT opened (WEB-STORAGE §2). */
export class StorageUnsupportedError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor() {
    super('This browser can’t keep FlashyDex data safely');
    this.name = 'StorageUnsupportedError';
  }
}

export type StartupFailure =
  | { kind: 'locked' }
  | { kind: 'unavailable'; code: string; message: string }
  | { kind: 'migration-blocked'; code: string; message: string }
  | { kind: 'error'; error: DomainError };

const UNAVAILABLE_CODES = new Set(['STORAGE_UNAVAILABLE', 'INIT_FAILED', 'PROTOCOL_MISMATCH', 'QUOTA', 'CAPACITY', 'WORKER_DIED']);
const BLOCKED_CODES = new Set(['MIGRATION_BLOCKED', 'METADATA_CORRUPT']);

/** WebStorageError (and subclasses such as MigrationBlockedError) crosses module/worker boundaries, so match by `code` shape, not instanceof. */
function storageCode(error: unknown): { code: string; message: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e.code !== 'string' || !(UNAVAILABLE_CODES.has(e.code) || BLOCKED_CODES.has(e.code))) return null;
  return { code: e.code, message: typeof e.message === 'string' ? e.message : '' };
}

export function classifyStartupError(error: unknown): StartupFailure {
  if (error instanceof InstanceLockedError) return { kind: 'locked' };
  const s = storageCode(error);
  if (s && BLOCKED_CODES.has(s.code)) return { kind: 'migration-blocked', ...s };
  if (s && UNAVAILABLE_CODES.has(s.code)) return { kind: 'unavailable', ...s };
  return { kind: 'error', error: toDomainError(error) };
}

/** Every `fdx:*` measure recorded so far (kept as performance entries in production for Settings → Diagnostics). */
export function fdxMeasures(): { name: string; ms: number; startMs: number }[] {
  if (typeof performance === 'undefined') return [];
  return performance
    .getEntriesByType('measure')
    .filter((m) => m.name.startsWith('fdx:'))
    .map((m) => ({ name: m.name, ms: Math.round(m.duration * 10) / 10, startMs: Math.round(m.startTime) }));
}

/** Dev only: one console.info line with every `fdx:*` startup measure (ms). */
function logStartupTimings(): void {
  if (!import.meta.env.DEV) return;
  const parts = fdxMeasures().map((m) => `${m.name}=${Math.round(m.ms)}ms`);
  console.info(`[fdx] startup ${parts.join(' ')}`);
}

let opening: Promise<Services> | null = null;

/**
 * Open storage exactly once per page load (StrictMode / HMR safe). Order matters: lock first (R01), then storage preparation
 * (worker, pool, USER resolution / legacy migration), then the user driver, then services.
 * Rejects with `InstanceLockedError` (no storage touched) when another tab owns the writer lock, and with
 * `StorageUnsupportedError` (no storage touched) on web without Web Locks.
 */
export function openAppServices(): Promise<Services> {
  opening ??= timed('fdx:gate-total', async () => {
    const lock = await acquireInstanceLock();
    if (lock === 'denied') throw new InstanceLockedError();
    if (lock === 'unsupported') throw new StorageUnsupportedError();
    try {
      await timed('fdx:storage-prepare', () => prepareStorage((p) => setStartupProgress(p)));
    } finally {
      setStartupProgress(null);
    }
    const userDriver = await timed('fdx:db-open', () => createUserDriver());
    return timed('fdx:services', async () => {
      const services = await createServices({
        userDriver,
        catalogSource,
        env: appEnvironment,
        installPort: withMetricsRecording(createInstallPort()),
        platform,
        appVersion: '0.1.0',
        catalog: catalogConfig()
      });
      // DEV-ONLY e2e hook (stripped from production builds): lets a spec drive a second code path against the live services.
      if (import.meta.env.DEV) {
        const w = window as unknown as { __flashydexTest?: Record<string, unknown> };
        w.__flashydexTest = { ...(w.__flashydexTest ?? {}), services };
      }
      return services;
    });
  }).finally(logStartupTimings);
  opening.catch((error: unknown) => {
    if (!(error instanceof InstanceLockedError) && !(error instanceof StorageUnsupportedError)) opening = null;
  });
  return opening;
}

export const asDomainError = (error: unknown): DomainError => toDomainError(error);
