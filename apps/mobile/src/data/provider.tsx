import { useEffect, useState, type ReactNode } from 'react';
import { AppServicesContext, type StartupState } from './context';
import { asDomainError, InstanceLockedError, openAppServices } from './bootstrap';

/**
 * Opens the user DB, runs the user migration chain, reconciles installed catalogs / interrupted install jobs, builds the services.
 * Renders children immediately; hooks stay disabled until `useAppStartup().status === 'ready'`.
 * Must sit inside TanStack Query's QueryClientProvider.
 */
export function AppServicesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StartupState>({ status: 'opening', error: null, services: null });
  useEffect(() => {
    let live = true;
    openAppServices().then(
      (services) => { if (live) setState({ status: 'ready', error: null, services }); },
      (error: unknown) => {
        if (!live) return;
        if (error instanceof InstanceLockedError) setState({ status: 'locked', error: null, services: null });
        else setState({ status: 'error', error: asDomainError(error), services: null });
      }
    );
    return () => { live = false; };
  }, []);
  return <AppServicesContext.Provider value={state}>{children}</AppServicesContext.Provider>;
}
