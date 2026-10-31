import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_modal')({ component: ModalLayout });

/** Full-screen modal presentation: no tab bar. Each modal page renders its own <ModalPage> chrome. */
function ModalLayout() {
  return (
    <div className="animate-[fd-fade-in_var(--ps-dur-fade)_both]">
      <Outlet />
    </div>
  );
}
