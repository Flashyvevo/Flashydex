import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CatalogProgress, CatalogStatus, CatalogUpdateCheck, DomainError, InstalledCatalog, Language } from '@flashydex/core';
import { useServices, useServicesIfReady } from './context';
import { invalidateAll, keys } from './keys';

/**
 * Install progress lives OUTSIDE React so a download keeps running while screens mount/unmount (CatalogInstallService is app-scoped).
 * UI components only observe; unmounting never cancels.
 */
type InstallState = { progress: CatalogProgress | null; active: boolean; error: DomainError | null; errorLanguage: Language | null };
let state: InstallState = { progress: null, active: false, error: null, errorLanguage: null };
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const setState = (next: InstallState) => { state = next; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** `GET /manifest` check for the selected (or given) languages: sizes, versions, whether an update exists. Never installs. */
export function useCatalogManifest(languages?: Language[]) {
  const services = useServicesIfReady();
  return useQuery<CatalogUpdateCheck, DomainError>({
    queryKey: keys.manifest(languages),
    enabled: services !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: ({ signal }) => (services as NonNullable<typeof services>).install.checkManifest(languages ? { languages } : undefined, signal)
  });
}

/** Persisted installed receipt + job + last error + capabilities. Polls while an install is running. */
export function useCatalogStatus(language: Language) {
  const services = useServicesIfReady();
  const active = useSyncExternalStore(subscribe, () => state.active);
  return useQuery<CatalogStatus, DomainError>({
    queryKey: keys.catalogStatus(language),
    enabled: services !== null,
    refetchInterval: active ? 1000 : false,
    queryFn: () => (services as NonNullable<typeof services>).install.status(language)
  });
}

export type CatalogInstallControls = {
  start: (language: Language) => Promise<InstalledCatalog | null>;
  cancel: () => void;
  progress: CatalogProgress | null;
  active: boolean;
  /** Last failure of a `start()` in this session (cleared by the next start). */
  error: DomainError | null;
  /** Language the `error` belongs to. */
  errorLanguage: Language | null;
};

/**
 * Start / cancel / observe the (single, global) catalog install. `start` resolves with the installed receipt, or null when it
 * failed or was cancelled (see `error`). It never throws, so a fire-and-forget button handler is safe.
 */
export function useCatalogInstall(): CatalogInstallControls {
  const services = useServices();
  const qc = useQueryClient();
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const servicesRef = useRef(services);
  servicesRef.current = services;

  const start = useCallback(async (language: Language): Promise<InstalledCatalog | null> => {
    if (state.active) return null;
    controller = new AbortController();
    setState({ progress: null, active: true, error: null, errorLanguage: null });
    try {
      const installed = await servicesRef.current.install.install(language, (progress) => setState({ ...state, progress }), controller.signal);
      setState({ progress: state.progress, active: false, error: null, errorLanguage: null });
      await invalidateAll(qc);
      return installed;
    } catch (error) {
      setState({ progress: state.progress, active: false, error: error as DomainError, errorLanguage: language });
      await invalidateAll(qc);
      return null;
    } finally {
      controller = null;
    }
  }, [qc]);

  const cancel = useCallback(() => { controller?.abort(); }, []);
  return { start, cancel, progress: snapshot.progress, active: snapshot.active, error: snapshot.error, errorLanguage: snapshot.errorLanguage };
}

/** `uninstall({language, confirm:true})`: removes only that catalog; owned copies, history and settings stay. */
export function useUninstallCatalog() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<InstalledCatalog, DomainError, Language>({ retry: false, mutationFn: (language) => services.install.uninstall({ language, confirm: true }), onSuccess: () => invalidateAll(qc) });
}

export function useRollbackCatalog() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<InstalledCatalog, DomainError, Language>({ retry: false, mutationFn: (language) => services.install.rollback(language), onSuccess: () => invalidateAll(qc) });
}
