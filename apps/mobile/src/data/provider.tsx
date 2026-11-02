import { useEffect, useState, type ReactNode } from 'react';
import { AppServicesContext, type StartupState } from './context';
import { classifyStartupError, openAppServices } from './bootstrap';

/**
 * Opens the user DB, runs the user migration chain, reconciles installed catalogs / interrupted install jobs, builds the services.
 * Renders children immediately; hooks stay disabled until `useAppStartup().status === 'ready'`.
 * Must sit inside TanStack Query's QueryClientProvider.
 */
export function AppServicesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StartupState>({ status: 'opening', error: null, services: null, storage: null });
  useEffect(() => {
    let live = true;
    openAppServices().then(
      (services) => { if (live) setState({ status: 'ready', error: null, services, storage: null }); },
      (error: unknown) => {
        if (!live) return;
        const failure = classifyStartupError(error);
        if (failure.kind === 'locked') setState({ status: 'locked', error: null, services: null, storage: null });
        else if (failure.kind === 'unavailable') setState({ status: 'unavailable', error: null, services: null, storage: { code: failure.code, message: failure.message } });
        else if (failure.kind === 'migration-blocked') setState({ status: 'migration-blocked', error: null, services: null, storage: { code: failure.code, message: failure.message } });
        else setState({ status: 'error', error: failure.error, services: null, storage: null });
      }
    );
    return () => { live = false; };
  }, []);
  return <AppServicesContext.Provider value={state}>{children}</AppServicesContext.Provider>;
}
