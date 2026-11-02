import { useEffect, useId, useSyncExternalStore } from 'react';

/**
 * Update handoff coordination (WEB-STORAGE §7, W13). Tiny module-level store so any form can register dirtiness and any
 * long job (install / import / restore) can register itself without prop drilling.
 */
const dirty = new Set<string>();
const busy = new Map<string, string>();
const listeners = new Set<() => void>();
let writesBlocked = false;

const emit = () => { listeners.forEach((l) => l()); };

export function setWritesBlockedForHandoff(on: boolean): void {
  writesBlocked = on;
  emit();
}
export const isHandoffBlocked = (): boolean => writesBlocked;
export const hasDirtyForms = (): boolean => dirty.size > 0;
/** Message of the first running job that forbids an update restart, or null. */
export const busyReason = (): string | null => busy.values().next().value ?? null;

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function useWritesBlockedForHandoff(): boolean {
  return useSyncExternalStore(subscribe, () => writesBlocked, () => false);
}

/** A form calls this with its dirty flag; while true, an update restart asks to discard first. */
export function useReportDirty(isDirty: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!isDirty) return;
    dirty.add(id);
    emit();
    return () => { dirty.delete(id); emit(); };
  }, [isDirty, id]);
}

/** A long-running job (catalog download, import, restore, migration) registers while active. */
export function useReportBusy(active: boolean, message: string): void {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    busy.set(id, message);
    emit();
    return () => { busy.delete(id); emit(); };
  }, [active, message, id]);
}
