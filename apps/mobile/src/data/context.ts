import { createContext, useContext, useRef, useSyncExternalStore } from 'react';
import { DomainError, type Services } from '@flashydex/core';

export type StartupState = { status: 'opening' | 'ready' | 'error' | 'locked'; error: DomainError | null; services: Services | null };

export const AppServicesContext = createContext<StartupState>({ status: 'opening', error: null, services: null });

/** Startup state of the data layer: user DB opened + migrated, installed catalogs reconciled, services built. `locked` = another tab owns the writer lock. */
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

type StorageStatus = ReturnType<Services['storage']['status']>;
const NOT_READY: StorageStatus = { writable: true, reason: 'ok', message: null };

/** Live `services.storage` status (persistence latch, instance-lock write block, maintenance). */
export function useStorageStatus(): StorageStatus {
  const services = useServicesIfReady();
  const cache = useRef<StorageStatus>(NOT_READY);
  // useSyncExternalStore requires a referentially stable snapshot: core returns a fresh object per call, so keep the last equal one.
  const snapshot = (): StorageStatus => {
    const next = services ? services.storage.status() : NOT_READY;
    const last = cache.current;
    if (last.writable === next.writable && last.reason === next.reason && last.message === next.message) return last;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore((listener) => (services ? services.storage.subscribe(listener) : () => undefined), snapshot, () => NOT_READY);
}
