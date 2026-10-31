import { createServices, timed, toDomainError, type DomainError, type Environment, type Services } from '@flashydex/core';
import { platform } from '../platform/app-platform';
import { catalogSource, createInstallPort, createUserDriver } from '../platform/app-database';
import { uuidV4 } from '../lib/uuid';

export const appEnvironment: Environment = {
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => uuidV4() }
};

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

/** Open storage exactly once per page load (StrictMode / HMR safe). */
export function openAppServices(): Promise<Services> {
  opening ??= timed('fdx:gate-total', async () => {
    const userDriver = await timed('fdx:db-open', () => createUserDriver());
    return timed('fdx:services', () =>
      createServices({ userDriver, catalogSource, env: appEnvironment, installPort: createInstallPort(), platform, appVersion: '0.1.0' })
    );
  }).finally(logStartupTimings);
  opening.catch(() => { opening = null; });
  return opening;
}

export const asDomainError = (error: unknown): DomainError => toDomainError(error);
