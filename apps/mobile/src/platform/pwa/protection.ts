import type { PersistState, ProtectionSnapshot, StorageProtectionController } from '../web-storage/contract';
import { createBrowserEnv, isStandalone, type PwaEnv } from './env';

export const PROTECTION_STORAGE_KEY = 'fdx:storage-protection:v1';

interface Stored {
  snapshot: ProtectionSnapshot;
}

/**
 * `check()` never calls persist(). `request()` must be called from a user gesture handler. Nothing here claims a browser prompt
 * was shown: the outcome is only ever what persisted() reports afterwards.
 * Before the first check, `checkedAt === null` (the persist field is then a placeholder and must be shown as "not checked yet").
 */
export function createStorageProtection(env: PwaEnv = createBrowserEnv()): StorageProtectionController {
  const listeners = new Set<(s: ProtectionSnapshot) => void>();
  let attached = false;
  let inflight: Promise<ProtectionSnapshot> | null = null;

  const storageApi = () => env.navigator?.storage;

  let snapshot: ProtectionSnapshot = load() ?? {
    persist: storageApi()?.persisted ? 'best-effort' : 'unavailable',
    checkedAt: null,
    usageBytes: null,
    quotaBytes: null,
    standalone: isStandalone(env),
    requested: false
  };

  function load(): ProtectionSnapshot | null {
    try {
      const raw = env.localStorage?.getItem(PROTECTION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<Stored>;
      const s = parsed.snapshot;
      if (!s || typeof s !== 'object') return null;
      const persist = (['granted', 'best-effort', 'unavailable', 'check-failed'] as const).find((p) => p === s.persist);
      if (!persist) return null;
      return {
        persist,
        checkedAt: typeof s.checkedAt === 'string' ? s.checkedAt : null,
        usageBytes: typeof s.usageBytes === 'number' ? s.usageBytes : null,
        quotaBytes: typeof s.quotaBytes === 'number' ? s.quotaBytes : null,
        standalone: isStandalone(env), // never trust a stored display mode
        requested: s.requested === true
      };
    } catch {
      return null;
    }
  }

  function commit(next: ProtectionSnapshot): ProtectionSnapshot {
    snapshot = next;
    try {
      env.localStorage?.setItem(PROTECTION_STORAGE_KEY, JSON.stringify({ snapshot } satisfies Stored));
    } catch {
      // private mode / quota: the in-memory snapshot is still correct
    }
    for (const l of [...listeners]) l(snapshot);
    return snapshot;
  }

  function attach() {
    if (attached) return;
    attached = true;
    env.document?.addEventListener('visibilitychange', () => {
      if (env.document?.visibilityState === 'visible' && isStandalone(env)) void controller.check();
    });
  }

  async function estimate(): Promise<{ usage: number | null; quota: number | null }> {
    try {
      const e = await storageApi()?.estimate?.();
      return { usage: typeof e?.usage === 'number' ? e.usage : null, quota: typeof e?.quota === 'number' ? e.quota : null };
    } catch {
      return { usage: null, quota: null };
    }
  }

  async function doCheck(override?: PersistState): Promise<ProtectionSnapshot> {
    let persist: PersistState;
    const api = storageApi();
    if (override) persist = override;
    else if (!api || typeof api.persisted !== 'function') persist = 'unavailable';
    else {
      try {
        persist = (await api.persisted()) ? 'granted' : 'best-effort';
      } catch {
        persist = 'check-failed';
      }
    }
    const { usage, quota } = await estimate();
    return commit({ persist, checkedAt: env.now().toISOString(), usageBytes: usage, quotaBytes: quota, standalone: isStandalone(env), requested: snapshot.requested });
  }

  const controller: StorageProtectionController = {
    check() {
      attach();
      inflight ??= doCheck().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async request() {
      attach();
      commit({ ...snapshot, requested: true }); // the user tapped; recorded before any outcome
      const api = storageApi();
      if (!api || typeof api.persisted !== 'function') return doCheck('unavailable');
      try {
        if (!(await api.persisted())) {
          if (typeof api.persist !== 'function') return doCheck('unavailable');
          await api.persist(); // result deliberately ignored: only a fresh persisted() is trusted
        }
      } catch {
        return doCheck('check-failed');
      }
      return doCheck();
    },

    getSnapshot: () => snapshot,

    subscribe(listener) {
      attach();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
  return controller;
}
