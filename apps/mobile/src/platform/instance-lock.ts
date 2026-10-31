import { Capacitor } from '@capacitor/core';

/**
 * Origin-wide exclusive USER-writer lock (R01 / D42). Two writable tabs would each hold an independent sql.js snapshot
 * and overwrite the same IndexedDB key, silently losing personal data, so the lock is taken BEFORE any storage is opened
 * and held for the page lifetime (the callback returns a promise that never settles; the browser releases it on unload/crash).
 *
 *  - `granted`     this page is the only writer.
 *  - `denied`      another page holds the lock: do NOT open storage, show the INSTANCE_LOCK screen.
 *  - `unsupported` no `navigator.locks` (insecure origin): open storage but refuse every write (userWriteBlock).
 *  - `native`      Capacitor ios/android: one process, no lock needed.
 */
export const INSTANCE_LOCK_NAME = 'flashydex-user-writer';
export type InstanceLockOutcome = 'granted' | 'denied' | 'unsupported' | 'native';

export const WRITES_BLOCKED_MESSAGE =
  'Editing is off: this browser can’t guarantee only one FlashyDex tab writes. Open FlashyDex over https or on localhost.';

let acquired: Promise<InstanceLockOutcome> | undefined;
/** Memoized per page: a retry after a failed storage open must not re-request (this page already holds the lock). */
export function acquireInstanceLock(): Promise<InstanceLockOutcome> {
  acquired ??= requestInstanceLock();
  return acquired;
}

function requestInstanceLock(): Promise<InstanceLockOutcome> {
  if (Capacitor.getPlatform() !== 'web') return Promise.resolve('native');
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return Promise.resolve('unsupported');
  return new Promise<InstanceLockOutcome>((resolve, reject) => {
    locks
      .request(INSTANCE_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve('denied');
          return undefined;
        }
        resolve('granted');
        return new Promise<void>(() => undefined); // held until the page goes away
      })
      .catch(reject);
  });
}

/**
 * Takeover: a blocking request that is granted once the other tab closes (or crashes). It then holds the lock (never
 * releases) and reloads, so the fresh page load re-acquires through the normal path after unload released it.
 * Returns a cancel function.
 */
export function waitForInstanceLock(onGranted: () => void): () => void {
  const locks = navigator.locks;
  const abort = new AbortController();
  void locks
    .request(INSTANCE_LOCK_NAME, { mode: 'exclusive', signal: abort.signal }, () => {
      onGranted();
      return new Promise<void>(() => undefined);
    })
    .catch(() => undefined); // AbortError on cancel
  return () => abort.abort();
}
