import { useEffect } from 'react';
import { Button } from './ui';
import { waitForInstanceLock } from '../platform/instance-lock';

/** Full-screen state shown when another tab owns the origin-wide writer lock (R01). Storage is NOT opened behind it. */
export function InstanceLockScreen() {
  // When the other tab closes (or crashes) the lock frees up: take over and reload so a fresh page load opens storage.
  useEffect(() => waitForInstanceLock(() => window.location.reload()), []);
  return (
    <div
      role="alert"
      className="flex min-h-dvh items-center justify-center bg-bg px-6"
      data-testid="instance-lock"
      style={{ paddingTop: 'var(--ps-safe-top)', paddingBottom: 'var(--ps-safe-bottom)' }}
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-h3 font-semibold">FlashyDex is open in another tab</h1>
        <p className="text-body text-fg-muted">Close the other tab, then reload this one.</p>
        <Button variant="primary" onClick={() => window.location.reload()} data-testid="instance-lock-reload">
          Reload
        </Button>
      </div>
    </div>
  );
}
