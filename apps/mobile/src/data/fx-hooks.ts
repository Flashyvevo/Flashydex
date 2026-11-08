import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FxProvider, FxRecord } from '@flashydex/core';
import { fetchFrankfurter } from '../lib/fx/frankfurter';
import { fxNeedsRefresh, fxStore, type FxStore } from '../lib/fx/store';
import { useNetwork } from '../lib/native';
import { invalidateAll } from './keys';

/** The sync, already-loaded EUR→USD snapshot handed to core (`createServices({ fx })`). Core never fetches. */
export const fxProvider: FxProvider = fxStore;

/** Live record (null = none cached). */
export function useFxRecord(): FxRecord | null {
  return useSyncExternalStore(fxStore.subscribe, fxStore.snapshot, () => null);
}

let inflight: Promise<boolean> | null = null;

type RefreshDeps = { store?: FxStore; fetchImpl?: typeof fetch; now?: () => string };

/**
 * Fetch once if the cache is missing/older than a day. Every attempt (success OR failure) is stamped first, so at most one network
 * call per 6 h regardless of outcome; concurrent callers coalesce. Resolves true when the snapshot changed. Failures keep the last valid record.
 */
export function refreshFxIfNeeded(deps: RefreshDeps = {}): Promise<boolean> {
  const store = deps.store ?? fxStore;
  const now = deps.now ?? (() => new Date().toISOString());
  if (inflight) return inflight;
  const nowIso = now();
  if (!fxNeedsRefresh(store.snapshot(), nowIso, store.lastAttemptAt())) return Promise.resolve(false);
  store.markAttempt(nowIso);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  inflight = fetchFrankfurter(fetchImpl, now)
    .then((record) => (record ? store.set(record, now()) : false))
    .catch(() => false)
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Mount once under the QueryClientProvider. Refreshes the rate on start and when connectivity returns; every change of the
 * record re-runs the value queries (dashboard, card details, lists) so derived USD values never go stale on screen.
 */
export function useFxSync(): void {
  const qc = useQueryClient();
  const { online } = useNetwork();
  const record = useFxRecord();
  useEffect(() => {
    if (online) void refreshFxIfNeeded();
  }, [online]);
  const stamp = record ? `${record.rateDate}:${record.rate}` : 'none';
  useEffect(() => {
    void invalidateAll(qc);
  }, [qc, stamp]);
}
