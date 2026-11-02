import { useEffect, useState } from 'react';
import type {
  ImageCacheStats, InstallState, PersistState, ProtectionSnapshot, UpdateState
} from '../platform/web-storage/contract';
import { imageCache, installController, PERSIST_STATUS_COPY, storageProtection, updateController } from './pwa-bridge';

function useController<T>(get: () => T, subscribe: (l: (s: T) => void) => () => void): T {
  const [state, setState] = useState<T>(get);
  useEffect(() => {
    setState(get());
    return subscribe(setState);
    // controllers are module singletons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

export const useProtection = (): ProtectionSnapshot => useController(() => storageProtection.getSnapshot(), (l) => storageProtection.subscribe(l));
export const useInstallState = (): InstallState => useController(() => installController.getState(), (l) => installController.subscribe(l));
export const useUpdateState = (): UpdateState => useController(() => updateController.getState(), (l) => updateController.subscribe(l));

/** Image cache stats, refreshed on mount and after each action. `null` until the first answer. */
export function useImageCacheStats(): { stats: ImageCacheStats | null; refresh: () => Promise<void>; set: (p: Promise<ImageCacheStats>) => Promise<void> } {
  const [stats, setStats] = useState<ImageCacheStats | null>(null);
  const refresh = async () => {
    try {
      setStats(await imageCache.stats());
    } catch {
      setStats({ enforced: false, limitBytes: 0, committedBytes: 0, reservedBytes: 0, entries: 0, lastError: null, reason: 'Couldn’t reach the offline art manager.' });
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = async (p: Promise<ImageCacheStats>) => {
    try {
      setStats(await p);
    } catch {
      await refresh();
    }
  };
  return { stats, refresh, set };
}

export const PERSIST_LABEL: Record<PersistState, { label: string; detail: string; tone: 'positive' | 'warning' | 'muted' }> = {
  granted: { label: 'Protected', detail: PERSIST_STATUS_COPY.granted, tone: 'positive' },
  'best-effort': { label: 'Not protected (browser decides)', detail: PERSIST_STATUS_COPY['best-effort'], tone: 'warning' },
  unavailable: { label: 'Unavailable', detail: PERSIST_STATUS_COPY.unavailable, tone: 'muted' },
  'check-failed': { label: 'Couldn’t check', detail: PERSIST_STATUS_COPY['check-failed'], tone: 'muted' }
};
