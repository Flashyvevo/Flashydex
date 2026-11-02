import { useSyncExternalStore } from 'react';
import type { StoragePrepareProgress } from '../platform/web-storage/contract';

/** Observable boot progress (migration / pool open) so the gate can render "Moving your collection…" without prop drilling. */
let progress: StoragePrepareProgress | null = null;
const listeners = new Set<() => void>();

export function setStartupProgress(next: StoragePrepareProgress | null): void {
  progress = next;
  listeners.forEach((l) => l());
}

export function useStartupProgress(): StoragePrepareProgress | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => progress, () => null);
}
