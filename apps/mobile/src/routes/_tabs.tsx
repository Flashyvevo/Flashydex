import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Sidebar, TabBar, useKeyboardInset } from '../components/shell';
import { InstallBanner } from '../components/pwa-ui';
import { SyncPill } from '../components/sync';

export const Route = createFileRoute('/_tabs')({ component: TabsLayout });

function TabsLayout() {
  const keyboardOpen = useKeyboardInset();
  return (
    <>
      <InstallBanner />
      <Outlet />
      <Sidebar />
      <div className="lg:hidden">
        <SyncPill />
      </div>
      <TabBar hidden={keyboardOpen} />
    </>
  );
}
