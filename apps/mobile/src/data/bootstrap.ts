import { createServices, toDomainError, type DomainError, type Environment, type Services } from '@flashydex/core';
import { platform } from '../platform/app-platform';
import { catalogSource, createInstallPort, createUserDriver } from '../platform/app-database';

export const appEnvironment: Environment = {
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => globalThis.crypto.randomUUID() }
};

let opening: Promise<Services> | null = null;

/** Open storage exactly once per page load (StrictMode / HMR safe). */
export function openAppServices(): Promise<Services> {
  opening ??= (async () => {
    const userDriver = await createUserDriver();
    return createServices({ userDriver, catalogSource, env: appEnvironment, installPort: createInstallPort(), platform, appVersion: '0.1.0' });
  })();
  opening.catch(() => { opening = null; });
  return opening;
}

export const asDomainError = (error: unknown): DomainError => toDomainError(error);
