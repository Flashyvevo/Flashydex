import type { QueryClient } from '@tanstack/react-query';
import { maybeShowProtectionPrompt } from '../lib/protection-prompt';

/** Every data query key starts with 'fd'. The second element names the resource; the rest is the exact input. */
export const keys = {
  settings: () => ['fd', 'settings'] as const,
  dashboard: (input: unknown) => ['fd', 'dashboard', input ?? null] as const,
  collection: (query: unknown) => ['fd', 'collection', query ?? null] as const,
  copy: (id: string) => ['fd', 'copy', id] as const,
  acquisitions: (q: unknown) => ['fd', 'acquisitions', q ?? null] as const,
  locations: (q: unknown) => ['fd', 'locations', q ?? null] as const,
  groups: (q: unknown) => ['fd', 'groups', q ?? null] as const,
  customList: (q: unknown) => ['fd', 'customList', q ?? null] as const,
  custom: (id: string) => ['fd', 'custom', id] as const,
  search: (q: unknown) => ['fd', 'search', q] as const,
  card: (input: unknown) => ['fd', 'card', input] as const,
  sets: (q: unknown) => ['fd', 'sets', q ?? null] as const,
  set: (key: unknown) => ['fd', 'set', key] as const,
  setCards: (q: unknown) => ['fd', 'setCards', q] as const,
  setIndex: (language: string) => ['fd', 'setIndex', language] as const,
  manifest: (languages: unknown) => ['fd', 'manifest', languages ?? null] as const,
  catalogStatus: (language: string) => ['fd', 'catalogStatus', language] as const,
  sync: () => ['fd', 'sync'] as const,
  ownedSetKeys: () => ['fd', 'ownedSetKeys'] as const,
  importReport: (id: string) => ['fd', 'import', id] as const,
  backupCapabilities: () => ['fd', 'backupCapabilities'] as const
};

const PERSONAL = ['collection', 'dashboard', 'copy', 'acquisitions', 'locations', 'groups', 'customList', 'custom', 'card', 'sets', 'set', 'setCards', 'search', 'ownedSetKeys'];

/** After a durable personal-data commit: everything derived from the collection refetches. */
export function invalidatePersonal(qc: QueryClient): Promise<void> {
  maybeShowProtectionPrompt(); // first successful personal save → one-time "Protect your collection" sheet (no-op afterwards)
  return qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'fd' && PERSONAL.includes(String(q.queryKey[1])) });
}

/** After catalog install / uninstall / rollback or a sync: catalog, value and status caches all change. */
export function invalidateAll(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['fd'] });
}
