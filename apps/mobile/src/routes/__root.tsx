import { Outlet, createRootRoute, useLocation, useNavigate } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppServicesProvider, useAppStartup, useSettings } from '../data';
import { ToastProvider } from '../components/overlay';
import { Button, EmptyState, ErrorState, LinkButton } from '../components/ui';
import { hideSplash, installBackButton } from '../lib/native';
import { useKeyboardInset } from '../components/shell';
import { InstanceLockScreen } from '../components/instance-lock';
import { StorageStatusUi } from '../components/storage-status';

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound
});

function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg" style={{ paddingTop: 'var(--ps-safe-top)' }}>
      <EmptyState icon={Compass} title="Page not found" body="That screen doesn’t exist." action={<LinkButton to="/" variant="primary" full>Go to Dashboard</LinkButton>} />
    </div>
  );
}

function RootLayout() {
  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
  }, []);
  return (
    <AppServicesProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </AppServicesProvider>
  );
}

function Gate() {
  const startup = useAppStartup();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (startup.status !== 'opening') return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [startup.status]);

  if (startup.status === 'locked') {
    hideSplash();
    return <InstanceLockScreen />;
  }
  if (startup.status === 'error') {
    hideSplash();
    return (
      <div role="alert" className="flex min-h-dvh items-center justify-center bg-bg" data-testid="startup-error" style={{ paddingTop: 'var(--ps-safe-top)', paddingBottom: 'var(--ps-safe-bottom)' }}>
        <ErrorState error={startup.error} onRetry={() => window.location.reload()} />
      </div>
    );
  }
  if (startup.status === 'opening') {
    return slow ? (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg text-fg-muted" role="status">
        <div className="size-16 rounded-xl bg-surface-3" aria-hidden />
        <p className="text-small">Opening your collection…</p>
      </div>
    ) : null;
  }
  return (
    <>
      <StorageStatusUi />
      <Ready />
    </>
  );
}

const OPEN_BEFORE_ONBOARDING = ['/settings/about', '/settings/privacy', '/settings/licenses', '/dev'];

function Ready() {
  const settings = useSettings();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useKeyboardInset();

  const needsOnboarding = settings.isSuccess && settings.data.onboardingCompletedAt === null;
  const allowed = pathname.startsWith('/welcome') || OPEN_BEFORE_ONBOARDING.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (needsOnboarding && !allowed) void navigate({ to: '/welcome', replace: true });
  }, [needsOnboarding, allowed, navigate]);

  useEffect(
    () =>
      installBackButton(() => {
        const tabRoots = ['/collection', '/sets', '/settings'];
        if (tabRoots.includes(window.location.pathname)) {
          void navigate({ to: '/', replace: true });
          return true;
        }
        return false;
      }),
    [navigate]
  );

  const ready = settings.isSuccess && !(needsOnboarding && !allowed);
  useEffect(() => {
    if (ready || settings.isError) requestAnimationFrame(() => requestAnimationFrame(hideSplash));
  }, [ready, settings.isError]);

  if (settings.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg" style={{ paddingTop: 'var(--ps-safe-top)' }}>
        <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
      </div>
    );
  }
  if (!ready) return null;
  return <Outlet />;
}

export { Button };
