import type { InstallController, InstallState } from '../web-storage/contract';
import { createBrowserEnv, isStandalone, type PwaEnv } from './env';

export const INSTALL_DISMISSED_KEY = 'fdx:install-dismissed:v1';
export const INSTALL_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

export function detectPlatform(nav: PwaEnv['navigator']): InstallState['platform'] {
  const ua = nav?.userAgent ?? '';
  // iPadOS 13+ reports a Mac desktop UA; touch points are the tell.
  if (/iPhone|iPad|iPod/i.test(ua) || (nav?.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function createInstallController(env: PwaEnv = createBrowserEnv()): InstallController {
  const listeners = new Set<(s: InstallState) => void>();
  let started = false;
  let deferred: BeforeInstallPromptEvent | null = null;
  let installed = false;
  let dismissedAt: string | null = readDismissed();
  let last: InstallState | null = null;

  function readDismissed(): string | null {
    try {
      const raw = env.localStorage?.getItem(INSTALL_DISMISSED_KEY) ?? null;
      return raw !== null && Number.isFinite(Date.parse(raw)) ? raw : null;
    } catch {
      return null;
    }
  }

  function compute(): InstallState {
    const standalone = isStandalone(env) || installed;
    const platform = detectPlatform(env.navigator);
    const canPrompt = platform !== 'ios' && deferred !== null;
    const snoozed = dismissedAt !== null && env.now().getTime() - Date.parse(dismissedAt) < INSTALL_SNOOZE_MS;
    return { standalone, platform, canPrompt, dismissedAt, showBanner: !standalone && !snoozed && (platform === 'ios' || canPrompt || platform === 'android') };
  }

  function emit() {
    const next = compute();
    if (last && JSON.stringify(last) === JSON.stringify(next)) return;
    last = next;
    for (const l of [...listeners]) l(next);
  }

  const controller: InstallController = {
    start() {
      if (started) return;
      started = true;
      env.window?.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault(); // we show our own, dismissible, honest UI
        deferred = event as BeforeInstallPromptEvent;
        emit();
      });
      env.window?.addEventListener('appinstalled', () => {
        installed = true;
        deferred = null;
        emit();
      });
      try {
        env.window?.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', emit);
      } catch {
        // ignore
      }
    },

    getState() {
      last = compute();
      return last;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async prompt() {
      const event = deferred;
      if (!event) return 'unavailable';
      deferred = null; // a captured prompt is single-use
      try {
        await event.prompt();
        const choice = await event.userChoice;
        if (choice.outcome === 'dismissed') controller.dismiss();
        else emit();
        return choice.outcome;
      } catch {
        emit();
        return 'unavailable';
      }
    },

    dismiss() {
      dismissedAt = env.now().toISOString();
      try {
        env.localStorage?.setItem(INSTALL_DISMISSED_KEY, dismissedAt);
      } catch {
        // in-memory snooze still applies for this session
      }
      emit();
    }
  };
  return controller;
}
