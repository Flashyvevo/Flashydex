// Device-local view preferences (D16/D17). Not personal data, not exported. Keys are `flashydex.*`.
import { useSyncExternalStore } from 'react';

const PREFIX = 'flashydex.pref.';
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference is session-only */
  }
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

export type SearchLanguage = 'all' | 'en' | 'ja';
export type CollectionView = 'grid' | 'list';

export const prefs = {
  haptics: (): boolean => read(`${PREFIX}haptics`) !== 'off',
  setHaptics: (on: boolean) => write(`${PREFIX}haptics`, on ? 'on' : 'off'),
  searchLanguage: (): SearchLanguage => {
    const v = read(`${PREFIX}searchLanguage`);
    return v === 'en' || v === 'ja' ? v : 'all';
  },
  setSearchLanguage: (v: SearchLanguage) => write(`${PREFIX}searchLanguage`, v),
  collectionView: (): CollectionView => (read(`${PREFIX}collectionView`) === 'list' ? 'list' : 'grid'),
  setCollectionView: (v: CollectionView) => write(`${PREFIX}collectionView`, v)
};

export function useHapticsPref(): boolean {
  return useSyncExternalStore(subscribe, prefs.haptics, () => true);
}
export function useSearchLanguagePref(): SearchLanguage {
  return useSyncExternalStore(subscribe, prefs.searchLanguage, () => 'all' as SearchLanguage);
}
export function useCollectionViewPref(): CollectionView {
  return useSyncExternalStore(subscribe, prefs.collectionView, () => 'grid' as CollectionView);
}

// ---- last backup (D17) ----
const LAST_BACKUP_KEY = 'flashydex.lastBackup';
export type LastBackup = { at: string; totalCards: number };
export function readLastBackup(): LastBackup | null {
  const raw = read(LAST_BACKUP_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as LastBackup;
    return typeof v.at === 'string' && typeof v.totalCards === 'number' ? v : null;
  } catch {
    return null;
  }
}
export function writeLastBackup(value: LastBackup): void {
  write(LAST_BACKUP_KEY, JSON.stringify(value));
}
export function useLastBackup(): LastBackup | null {
  const raw = useSyncExternalStore(subscribe, () => read(LAST_BACKUP_KEY), () => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastBackup;
  } catch {
    return null;
  }
}

// ---- add-flow session memory (UX §7.3): sessionStorage only, never the DB ----
const SESSION_KEY = 'flashydex.addSession';
export type AddSession = {
  storageLocationId?: string | null;
  groupId?: string | null;
  condition?: string | null;
  purchase?: { price?: string; currency?: string; date?: string; source?: string } | null;
  keep: { location: boolean; group: boolean; condition: boolean; purchase: boolean };
};
export function readAddSession(): AddSession {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw) as AddSession;
  } catch {
    /* ignore */
  }
  return { keep: { location: true, group: true, condition: false, purchase: false } };
}
export function writeAddSession(s: AddSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
