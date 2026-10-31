import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServices, useStorageStatus } from '../data';
import { Banner, Button } from './ui';

/**
 * Storage safety UI (R01 / R02), mounted once above the app:
 *  - `instance_lock` (no Web Locks): persistent `writes-blocked` banner; core refuses every personal write.
 *  - `persistence_failed`: blocking `persistence-failed` overlay (nothing underneath is tappable). It calls
 *    `services.storage.recover()`; if the driver cannot re-read persisted state, the only honest option is a real reload.
 */
export function StorageStatusUi() {
  const status = useStorageStatus();
  return (
    <>
      {status.reason === 'instance_lock' && (
        <div className="fixed inset-x-0 top-0 px-3" style={{ zIndex: 'var(--ps-z-blocking)', paddingTop: 'calc(var(--ps-safe-top) + 4px)' }}>
          <Banner tone="warning" testId="writes-blocked">{status.message ?? 'Editing is off in this tab.'}</Banner>
        </div>
      )}
      {status.reason === 'persistence_failed' && <PersistenceFailed />}
      {status.maintenance?.kind === 'restore' && <RestoreMaintenance />}
      {status.maintenance?.kind === 'catalog_activation' && status.reason === 'ok' && (
        <div className="pointer-events-none fixed inset-x-0 top-0 flex justify-center px-3" style={{ zIndex: 'var(--ps-z-blocking)', paddingTop: 'calc(var(--ps-safe-top) + 4px)' }}>
          <div role="status" aria-live="polite" data-testid="catalog-activation-notice" className="rounded-full bg-surface-3 px-3 py-1 text-caption text-fg-muted shadow-2">
            Updating the {status.maintenance.language === 'ja' ? 'Japanese' : status.maintenance.language === 'en' ? 'English' : ''} catalog…
          </div>
        </div>
      )}
    </>
  );
}

/** Restore in progress (E1): blocks the whole app so nothing can be edited under the replacement. Core also refuses writes with MAINTENANCE. */
function RestoreMaintenance() {
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    return () => root?.removeAttribute('inert');
  }, []);
  return createPortal(
    <div
      role="alertdialog"
      aria-modal
      aria-live="assertive"
      aria-labelledby="maintenance-title"
      aria-describedby="maintenance-body"
      className="fixed inset-0 flex items-center justify-center bg-bg px-6"
      style={{ zIndex: 'var(--ps-z-blocking)' }}
      data-testid="maintenance-overlay"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h2 id="maintenance-title" className="text-h3 font-semibold">Restoring your backup…</h2>
        <p id="maintenance-body" className="text-body text-fg-muted">Don’t close FlashyDex. This takes a moment.</p>
      </div>
    </div>,
    document.body
  );
}

function PersistenceFailed() {
  const services = useServices();
  const qc = useQueryClient();
  const [phase, setPhase] = useState<'recovering' | 'failed'>('recovering');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    services.storage.recover().then(
      async () => {
        await qc.invalidateQueries();
      },
      () => setPhase('failed')
    );
  }, [services, qc]);
  return createPortal(
    <div
      role="alertdialog"
      aria-modal
      aria-labelledby="persistence-failed-title"
      className="fixed inset-0 flex items-center justify-center bg-bg px-6"
      style={{ zIndex: 'var(--ps-z-blocking)' }}
      data-testid="persistence-failed"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h2 id="persistence-failed-title" className="text-h3 font-semibold">Your last change may not have saved</h2>
        {phase === 'recovering' ? (
          <p className="text-body text-fg-muted" role="status">Checking what was saved. Editing is paused until this finishes.</p>
        ) : (
          <>
            <p className="text-body text-fg-muted">FlashyDex couldn’t re-check your data in place. Editing stays off until you reload. Check the card afterwards and add it again if it’s missing.</p>
            <Button variant="primary" onClick={() => window.location.reload()} data-testid="persistence-reload">Reload</Button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
