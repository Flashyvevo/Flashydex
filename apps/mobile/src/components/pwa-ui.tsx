import { Download, Share, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from './overlay';
import { Button } from './ui';
import { isNative } from '../lib/native';
import { busyReason, dismissHandoffFailure, hasDirtyForms, runUpdateHandoff, setWritesBlockedForHandoff, useHandoffUi, useWritesBlockedForHandoff, type HandoffDeps } from '../lib/handoff';
import { useInstallState, useUpdateState } from '../lib/pwa-hooks';
import { installController, updateController } from '../lib/pwa-bridge';
import { closeClientPath, openClientPaths, shutdownClient, writeGate } from '../lib/storage-bridge';
import { createUpdateController } from '../platform/pwa';
import { isCatalogInstallActive, useStorageStatus } from '../data';

/** DEV-only stand-in for a running job (see the seam below). */
let devBusy: string | null = null;

/** Everything the handoff needs from the app: running jobs, the write gate, the SQL client. */
function appHandoffDeps(restoreRunning: () => boolean = () => false): HandoffDeps {
  return {
    gate: writeGate,
    listOpenPaths: openClientPaths,
    closePath: closeClientPath,
    shutdownClient,
    busyReason: () => (isCatalogInstallActive() ? 'A catalog download is running.' : restoreRunning() ? 'A restore is running.' : (import.meta.env.DEV ? devBusy : null) ?? busyReason()),
    setBlocked: setWritesBlockedForHandoff
  };
}

/**
 * DEV-ONLY e2e seam (compiled out of production): runs the REAL handoff + the REAL update controller against a fake service worker, so a
 * spec can prove drain-before-close and exactly-one reload without a production build. `window.__fdxHandoffTest.reloads` counts reloads.
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as { __fdxHandoffTest?: unknown };
  const state = { reloads: 0 };
  w.__fdxHandoffTest = {
    state,
    setBusy: (message: string | null) => { devBusy = message; },
    run: (opts: { workerWaiting?: boolean } = {}) => {
      const listeners = new Set<() => void>();
      const waiting = { postMessage: () => { queueMicrotask(() => { for (const l of [...listeners]) l(); }); } };
      const controller = createUpdateController({
        env: {
          isProd: true,
          now: () => new Date(),
          reload: () => { state.reloads += 1; },
          navigator: {
            serviceWorker: {
              controller: { postMessage: () => undefined },
              addEventListener: (_t: 'controllerchange', l: () => void) => { listeners.add(l); },
              removeEventListener: (_t: 'controllerchange', l: () => void) => { listeners.delete(l); },
              getRegistration: () => Promise.resolve({ waiting: opts.workerWaiting === false ? null : waiting })
            }
          }
        },
        activationTimeoutMs: 1000
      });
      return runUpdateHandoff(appHandoffDeps(), (prepare) => controller.applyUpdate(prepare), () => controller.getState().error);
    }
  };
}

/**
 * Install banner (WEB-STORAGE §7). In-flow (never fixed): it sits at the top of the tab content so it cannot cover the tab bar or
 * safe area. Hidden when installed/standalone, on native, and for 14 days after dismissal (controller decides `showBanner`).
 */
export function InstallBanner() {
  const state = useInstallState();
  const [msg, setMsg] = useState<string | null>(null);
  if (isNative() || !state.showBanner) return null;
  const instructions =
    state.platform === 'ios'
      ? 'Install FlashyDex: tap Share, then Add to Home Screen, then open FlashyDex from its icon. Installed apps are kept more safely than Safari tabs.'
      : state.platform === 'android'
        ? 'Install FlashyDex from your browser menu: open the ⋮ menu, then Install app or Add to Home screen.'
        : 'Install FlashyDex from your browser’s menu to open it like an app.';
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3 lg:pl-[calc(var(--ps-sidebar-w)+16px)]" data-testid="install-banner" data-platform={state.platform}>
      <div className="flex items-start gap-3 rounded-lg bg-surface-2 px-3 py-2 text-small" role="region" aria-label="Install FlashyDex">
        <span className="mt-1 shrink-0 text-accent-fg" aria-hidden>{state.platform === 'ios' ? <Share size={18} /> : <Download size={18} />}</span>
        <div className="min-w-0 flex-1">
          <p data-testid="install-text">{state.canPrompt ? 'Install FlashyDex for faster launch, offline use and safer storage.' : instructions}</p>
          {msg && <p className="mt-1 text-caption text-fg-muted">{msg}</p>}
          {state.canPrompt && (
            <Button
              variant="primary"
              className="mt-2"
              data-testid="install-button"
              onClick={() => void installController.prompt().then((r) => setMsg(r === 'dismissed' ? 'No problem. You can install later from your browser menu.' : null))}
            >
              Install
            </Button>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss install tip"
          data-testid="install-dismiss"
          onClick={() => installController.dismiss()}
          className="-mr-1 inline-flex size-(--ps-tap) shrink-0 items-center justify-center rounded-full text-fg-muted"
        >
          <X size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/**
 * "Update ready" toast + the handoff. Restart is refused while a download/import/restore runs, asks before discarding a dirty form,
 * blocks the whole UI (so nothing new is written), shuts the SQL worker down, then lets the controller activate the new worker and
 * reload exactly once. `Later` keeps the current version running.
 */
export function UpdateToast() {
  const update = useUpdateState();
  const blocked = useWritesBlockedForHandoff();
  const handoffUi = useHandoffUi();
  const storage = useStorageStatus();
  const [dismissed, setDismissed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const runHandoff = () => {
    setRefusal(null);
    return runUpdateHandoff(appHandoffDeps(() => Boolean(storage.maintenance)), (prepare) => updateController.applyUpdate(prepare), () => updateController.getState().error);
  };

  const restart = () => {
    const maintenance = storage.maintenance;
    const reason = isCatalogInstallActive() ? 'Finish the catalog download first.' : maintenance ? 'Finish the restore first.' : busyReason();
    if (reason) {
      setRefusal(reason);
      return;
    }
    if (hasDirtyForms()) {
      setConfirm(true);
      return;
    }
    void runHandoff();
  };

  return (
    <>
      {update.needRefresh && !dismissed && !blocked && (
        <div className="pointer-events-none fixed inset-x-0 flex justify-center px-3" style={{ zIndex: 'var(--ps-z-toast)', bottom: 'calc(var(--ps-tabbar-total) + 8px)' }}>
          <div role="status" aria-live="polite" data-testid="update-toast" className="pointer-events-auto flex w-full max-w-md flex-col gap-2 rounded-lg bg-surface-3 px-4 py-3 text-small shadow-3">
            <p className="font-semibold">Update ready</p>
            <p className="text-fg-muted" data-testid="update-note">{refusal ?? 'Restart to use the new version. Your collection stays as it is.'}</p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={restart} loading={update.applying} data-testid="update-restart">Restart</Button>
              <Button variant="text" onClick={() => { updateController.later(); setDismissed(true); setRefusal(null); }} data-testid="update-later">Later</Button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Discard unsaved changes?"
        body="You have edits that aren’t saved yet. Restarting for the update will discard them."
        confirmLabel="Discard and restart"
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => { setConfirm(false); void runHandoff(); }}
        testId="update-discard"
      />
      {(blocked || handoffUi.phase !== 'idle') && <HandoffOverlay />}
    </>
  );
}

function HandoffOverlay() {
  const { phase, failure } = useHandoffUi();
  return createPortal(
    <div
      role="alertdialog"
      aria-modal
      aria-live="assertive"
      aria-label="Updating FlashyDex"
      className="fixed inset-0 flex items-center justify-center bg-bg px-6"
      style={{ zIndex: 'var(--ps-z-blocking)' }}
      data-testid="update-handoff"
    >
      {phase === 'failed' && failure ? (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center" data-testid="update-handoff-failed">
          <h2 className="text-h3 font-semibold">{failure.recoverable ? 'The update has to wait' : 'FlashyDex needs a reload'}</h2>
          <p className="text-body text-fg-muted" data-testid="update-handoff-message">{failure.message}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {failure.offerReload && <Button variant="primary" onClick={() => window.location.reload()} data-testid="update-handoff-reload">Reload</Button>}
            {failure.recoverable && <Button variant={failure.offerReload ? 'text' : 'primary'} onClick={() => dismissHandoffFailure()} data-testid="update-handoff-later">Restart later</Button>}
          </div>
        </div>
      ) : (
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <h2 className="text-h3 font-semibold">Restarting to update…</h2>
          <p className="text-body text-fg-muted">Saving everything first. FlashyDex reopens in a moment.</p>
        </div>
      )}
    </div>,
    document.body
  );
}
