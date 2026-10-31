import { createContext, useContext } from 'react';
import { DomainError, type Services } from '@flashydex/core';

export type StartupState = { status: 'opening' | 'ready' | 'error'; error: DomainError | null; services: Services | null };

export const AppServicesContext = createContext<StartupState>({ status: 'opening', error: null, services: null });

/** Startup state of the data layer: user DB opened + migrated, installed catalogs reconciled, services built. */
export function useAppStartup(): { status: StartupState['status']; error: DomainError | null } {
  const { status, error } = useContext(AppServicesContext);
  return { status, error };
}

/** Escape hatch: the composed core services. Prefer the hooks. Throws while the app is still opening. */
export function useServices(): Services {
  const { services, status } = useContext(AppServicesContext);
  if (!services) throw new DomainError('NOT_READY', status === 'error' ? 'Storage failed to open' : 'Storage is still opening');
  return services;
}

/** Query hooks use this to stay disabled until storage is ready (no placeholder data while opening). */
export function useServicesIfReady(): Services | null {
  return useContext(AppServicesContext).services;
}
