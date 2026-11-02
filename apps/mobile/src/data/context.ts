import { createContext, useContext, useRef, useSyncExternalStore } from 'react';
import { DomainError, type Services } from '@flashydex/core';

export type StartupState = {
  status: 'opening' | 'ready' | 'error' | 'locked' | 'unavailable' | 'migration-blocked';
  error: DomainError | null;
  services: Services | null;
  /** Sanitized storage failure code + message for the 'unavailable' / 'migration-blocked' screens. */
  storage: { code: string; message: string } | null;
};

export const AppServicesContext = createContext<StartupState>({ status: 'opening', error: null, services: null, storage: null });

/** Startup state of the data layer: user DB opened + migrated, installed catalogs reconciled, services built. `locked` = another tab owns the writer lock. */
export function useAppStartup(): { status: StartupState['status']; error: DomainError | null; storage: StartupState['storage'] } {
  const { status, error, storage } = useContext(AppServicesContext);
  return { status, error, storage };
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
const NOT_READY: StorageStatus = { writable: true, reason: 'ok', message: null, maintenance: null };

/** Live `services.storage` status (persistence latch, instance-lock write block, maintenance). */
export function useStorageStatus(): StorageStatus {
  const services = useServicesIfReady();
  const cache = useRef<StorageStatus>(NOT_READY);
  // useSyncExternalStore requires a referentially stable snapshot: core returns a fresh object per call, so keep the last equal one.
  const snapshot = (): StorageStatus => {
    const next = services ? services.storage.status() : NOT_READY;
    const last = cache.current;
    const a = last.maintenance;
    const b = next.maintenance;
    const sameMaintenance = a === b || (!!a && !!b && a.kind === b.kind && a.language === b.language && a.since === b.since);
    if (last.writable === next.writable && last.reason === next.reason && last.message === next.message && sameMaintenance) return last;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore((listener) => (services ? services.storage.subscribe(listener) : () => undefined), snapshot, () => NOT_READY);
}
