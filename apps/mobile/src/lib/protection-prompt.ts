import { useSyncExternalStore } from 'react';

/**
 * "Protect your collection" sheet (WEB-STORAGE §2): shown ONCE per device, after the first successful personal save and before
 * the first full catalog download. Dismissible, never a wall. The flag only records that we asked, not that protection was granted.
 */
export const PROTECTION_SEEN_KEY = 'fdx:protection-seen';
const listeners = new Set<() => void>();
let open = false;

function seen(): boolean {
  try { return localStorage.getItem(PROTECTION_SEEN_KEY) === '1'; } catch { return true; }
}

/** Call at the trigger points; no-op after the first time. */
export function maybeShowProtectionPrompt(): void {
  if (open || seen()) return;
  open = true;
  listeners.forEach((l) => l());
}

export function dismissProtectionPrompt(): void {
  try { localStorage.setItem(PROTECTION_SEEN_KEY, '1'); } catch { /* session-only */ }
  open = false;
  listeners.forEach((l) => l());
}

export function useProtectionPromptOpen(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => false);
}
