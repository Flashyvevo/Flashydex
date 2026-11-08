import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FxProvider, FxRecord } from '@flashydex/core';
import { fetchFrankfurter } from '../lib/fx/frankfurter';
import { fxNeedsRefresh, fxStore } from '../lib/fx/store';
import { useNetwork } from '../lib/native';
import { invalidateAll } from './keys';

/** The sync, already-loaded EUR→USD snapshot handed to core (`createServices({ fx })`). Core never fetches. */
export const fxProvider: FxProvider = fxStore;

/** Live record (null = none cached). */
export function useFxRecord(): FxRecord | null {
  return useSyncExternalStore(fxStore.subscribe, fxStore.snapshot, () => null);
}

let inflight: Promise<boolean> | null = null;

/** Fetch once if the cache is missing/older than a day; resolves true when the snapshot changed. Failures keep the last verified record. */
export function refreshFxIfNeeded(): Promise<boolean> {
  const nowIso = new Date().toISOString();
  if (!fxNeedsRefresh(fxStore.snapshot(), nowIso)) return Promise.resolve(false);
  inflight ??= fetchFrankfurter(globalThis.fetch.bind(globalThis), () => new Date().toISOString())
    .then((record) => (record ? fxStore.set(record) : false))
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
