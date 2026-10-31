import { Outlet, createFileRoute } from '@tanstack/react-router';
import { Sidebar, TabBar, useKeyboardInset } from '../components/shell';
import { SyncPill } from '../components/sync';

export const Route = createFileRoute('/_tabs')({ component: TabsLayout });

function TabsLayout() {
  const keyboardOpen = useKeyboardInset();
  return (
    <>
      <Outlet />
      <Sidebar />
      <div className="lg:hidden">
        <SyncPill />
      </div>
      <TabBar hidden={keyboardOpen} />
    </>
  );
}
