import { createServices, timed, toDomainError, type DomainError, type Environment, type Services } from '@flashydex/core';
import { platform } from '../platform/app-platform';
import { catalogSource, createInstallPort, createUserDriver } from '../platform/app-database';
import { catalogConfig } from '../platform/catalog-config';
import { acquireInstanceLock, WRITES_BLOCKED_MESSAGE } from '../platform/instance-lock';
import { uuidV4 } from '../lib/uuid';

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

/** Dev only: one console.info line with every `fdx:*` startup measure (ms). */
function logStartupTimings(): void {
  if (!import.meta.env.DEV || typeof performance === 'undefined') return;
  const parts = performance
    .getEntriesByType('measure')
    .filter((m) => m.name.startsWith('fdx:'))
    .map((m) => `${m.name}=${Math.round(m.duration)}ms`);
  console.info(`[fdx] startup ${parts.join(' ')}`);
}

let opening: Promise<Services> | null = null;

/**
 * Open storage exactly once per page load (StrictMode / HMR safe). Order matters: lock first (R01), then the user DB.
 * Rejects with `InstanceLockedError` (no storage touched) when another tab owns the writer lock.
 */
export function openAppServices(): Promise<Services> {
  opening ??= timed('fdx:gate-total', async () => {
    const lock = await acquireInstanceLock();
    if (lock === 'denied') throw new InstanceLockedError();
    const userDriver = await timed('fdx:db-open', () => createUserDriver());
    return timed('fdx:services', () =>
      createServices({
        userDriver,
        catalogSource,
        env: appEnvironment,
        installPort: createInstallPort(),
        platform,
        appVersion: '0.1.0',
        catalog: catalogConfig(),
        userWriteBlock: lock === 'unsupported' ? { reason: 'instance_lock', message: WRITES_BLOCKED_MESSAGE } : undefined
      })
    );
  }).finally(logStartupTimings);
  opening.catch((error: unknown) => { if (!(error instanceof InstanceLockedError)) opening = null; });
  return opening;
}

export const asDomainError = (error: unknown): DomainError => toDomainError(error);
