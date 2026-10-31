// Native plumbing for the UI: haptics, external links, network state, splash. Always safe on web.
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { Network } from '@capacitor/network';
import { SplashScreen } from '@capacitor/splash-screen';
import { useEffect, useState } from 'react';
import { prefs } from './prefs';

export const isNative = (): boolean => Capacitor.isNativePlatform();

export type HapticKind = 'added' | 'undo' | 'deleted' | 'saved' | 'error' | 'select' | 'threshold' | 'longpress' | 'synced';

/** Fire after a commit resolves. No-op on web, or when the haptics preference is off. */
export function haptic(kind: HapticKind): void {
  if (!isNative() || !prefs.haptics()) return;
  const run = async () => {
    switch (kind) {
      case 'added':
      case 'synced':
        await Haptics.notification({ type: NotificationType.Success });
        break;
      case 'deleted':
        await Haptics.notification({ type: NotificationType.Warning });
        break;
      case 'error':
        await Haptics.notification({ type: NotificationType.Error });
        break;
      case 'undo':
      case 'saved':
        await Haptics.impact({ style: ImpactStyle.Light });
        break;
      case 'select':
        await Haptics.selectionChanged();
        break;
      default:
        await Haptics.impact({ style: ImpactStyle.Medium });
    }
  };
  void run().catch(() => undefined);
}

export function hideSplash(): void {
  if (!isNative()) return;
  void SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => undefined);
}

/** External links open in the in-app browser (SFSafariViewController / Custom Tabs), never the WebView. */
export async function openExternal(url: string): Promise<void> {
  if (isNative()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export type NetworkState = { online: boolean; cellular: boolean };

export function useNetwork(): NetworkState {
  const [state, setState] = useState<NetworkState>({ online: typeof navigator === 'undefined' ? true : navigator.onLine, cellular: false });
  useEffect(() => {
    let cancelled = false;
    const onOnline = () => setState((s) => ({ ...s, online: true }));
    const onOffline = () => setState((s) => ({ ...s, online: false }));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    let remove: (() => void) | undefined;
    if (isNative()) {
      void Network.getStatus().then((s) => !cancelled && setState({ online: s.connected, cellular: s.connectionType === 'cellular' }));
      void Network.addListener('networkStatusChange', (s) => setState({ online: s.connected, cellular: s.connectionType === 'cellular' })).then((h) => {
        remove = () => void h.remove();
      });
    }
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      remove?.();
    };
  }, []);
  return state;
}

/** Android hardware back: `handler` returns true if it consumed the event. */
export function installBackButton(handler: () => boolean): () => void {
  if (Capacitor.getPlatform() !== 'android') return () => undefined;
  let removal: (() => void) | undefined;
  void App.addListener('backButton', () => {
    if (!handler()) {
      if (window.history.length > 1) window.history.back();
      else void App.minimizeApp();
    }
  }).then((h) => {
    removal = () => void h.remove();
  });
  return () => removal?.();
}

export async function appVersion(): Promise<{ version: string; build: string | null; native: boolean }> {
  if (isNative()) {
    try {
      const info = await App.getInfo();
      return { version: info.version, build: info.build, native: true };
    } catch {
      /* fall through */
    }
  }
  return { version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '1.0.0', build: null, native: false };
}
