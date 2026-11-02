import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyPlatformClass } from './platform/platform';
import { installController, updateController } from './lib/pwa-bridge';
import { TRANSIENT_READ_RETRY_DELAY_MS, retryTransientRead } from './lib/query-retry';
import { routeTree } from './routeTree.gen';
import './styles/globals.css';

applyPlatformClass();
// PWA controllers (web only; both are no-ops on native and in dev/test). start() attaches install listeners early so
// `beforeinstallprompt` is never missed; register() only runs in production/preview builds.
installController.start();
updateController.register();

const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true });
const queryClient = new QueryClient({
  // Reads: one silent refetch for STALE_READ / MAINTENANCE (E2), nothing else. Mutations default to no retry.
  defaultOptions: { queries: { retry: retryTransientRead, retryDelay: TRANSIENT_READ_RETRY_DELAY_MS, refetchOnWindowFocus: false, staleTime: 0 } }
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('FlashyDex root element was not found.');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
