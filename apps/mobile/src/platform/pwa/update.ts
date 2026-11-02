import { SW_MESSAGES, type UpdateController, type UpdateState } from '../web-storage/contract';
import { createBrowserEnv, type PwaEnv } from './env';

type RegisterSW = typeof import('virtual:pwa-register').registerSW;

export interface UpdateDeps {
  env?: PwaEnv;
  /** Lazy loader for vite-plugin-pwa's virtual module. Only ever called in production builds. */
  loadRegister?: () => Promise<{ registerSW: RegisterSW }>;
  /** How long to wait for the new worker to take control after SKIP_WAITING before reporting an error. */
  activationTimeoutMs?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Update failed');

/**
 * Prompt-style updates (never autoUpdate). The shell supplies `prepare` (block writes, drain jobs, confirm edits, shutdown the DB
 * worker, release the lock); only after it resolves is the waiting worker told to activate, and the page reloads exactly once.
 */
export function createUpdateController(deps: UpdateDeps = {}): UpdateController {
  const env = deps.env ?? createBrowserEnv();
  const loadRegister = deps.loadRegister ?? (() => import('virtual:pwa-register'));
  const activationTimeoutMs = deps.activationTimeoutMs ?? 15_000;

  let state: UpdateState = { registered: false, needRefresh: false, offlineReady: false, applying: false, error: null };
  const listeners = new Set<(s: UpdateState) => void>();
  let registration: { waiting?: { postMessage(m: unknown): void } | null } | undefined;
  let registerCalled = false;
  let reloaded = false; // guard: at most ONE reload per page lifetime, whoever triggers it
  let hadController = false;

  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l(state);
  };

  function reloadOnce() {
    if (reloaded) return;
    reloaded = true;
    env.reload();
  }

  return {
    register() {
      if (registerCalled) return;
      registerCalled = true;
      if (!env.isProd || !env.navigator?.serviceWorker) return; // dev/unsupported: no SW, registered stays false
      hadController = Boolean(env.navigator.serviceWorker.controller);
      void loadRegister()
        .then(({ registerSW }) => {
          registerSW({
            immediate: true,
            onNeedRefresh: () => set({ needRefresh: true }),
            onOfflineReady: () => set({ offlineReady: true }),
            onRegisteredSW: (_url, reg) => {
              registration = reg as typeof registration;
              set({ registered: true });
            },
            onRegisterError: (e) => set({ error: message(e) })
          });
          // A different tab applied an update: this (blocked) tab must not keep an old writer adapter around.
          env.navigator?.serviceWorker?.addEventListener('controllerchange', () => {
            if (!hadController) {
              hadController = true; // first-install claim, not an update
              return;
            }
            if (!state.applying) reloadOnce();
          });
        })
        .catch((e) => set({ error: message(e) }));
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async applyUpdate(prepare) {
      if (state.applying) return;
      set({ applying: true, error: null });
      try {
        await prepare();
      } catch (e) {
        set({ applying: false, error: message(e) }); // nothing activates
        return;
      }
      const sw = env.navigator?.serviceWorker;
      let reg = registration;
      try {
        reg ??= await sw?.getRegistration();
      } catch {
        // handled below
      }
      const waiting = reg?.waiting;
      if (!sw || !waiting) {
        set({ applying: false, error: 'No update is waiting' });
        return;
      }
      const worker = sw;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          worker.removeEventListener('controllerchange', onChange);
          set({ applying: false, error: 'The update did not activate' });
          resolve();
        }, activationTimeoutMs);
        function onChange() {
          clearTimeout(timer);
          worker.removeEventListener('controllerchange', onChange);
          reloadOnce();
          resolve();
        }
        worker.addEventListener('controllerchange', onChange); // listen BEFORE asking it to activate
        waiting.postMessage({ type: SW_MESSAGES.skipWaiting });
      });
    },

    later() {
      // Keeps the old UI and storage as-is; the waiting worker is re-detected (onNeedRefresh) on the next page load.
      set({ needRefresh: false });
    }
  };
}
