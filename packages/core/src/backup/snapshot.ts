import type { Exec } from '../db/sql';
import { readSettings, readRevision } from '../services/context';
import { readPersonalSnapshot } from '../transfer/snapshot';
import type { Entities, Settings } from './archive';

export const DEFAULT_IMAGE_CACHE_LIMIT_BYTES = 200_000_000;

type PriceRow = Entities['priceSnapshots'][number];
const PRICE_COLS = {
  id: 'id', catalogCardId: 'catalog_card_id', language: 'language', source: 'source', variant: 'variant', variantDetail: 'variant_detail',
  providerVariantKey: 'provider_variant_key', currency: 'currency', lowCents: 'low_cents', midCents: 'mid_cents', highCents: 'high_cents',
  marketCents: 'market_cents', trendCents: 'trend_cents', sourceUpdatedAt: 'source_updated_at', capturedAt: 'captured_at', observationKey: 'observation_key'
} as const;

/**
 * ALL personal state from ONE read session (call inside `db.read`): every personal table incl. unowned history, annotations and
 * identities, plus settings. Reuses the JSON export snapshot for the entity tables, then replaces the price history with the
 * COMPLETE table (the JSON export only carries history for owned identities).
 */
export async function readFullSnapshot(q: Exec): Promise<{ entities: Entities; settings: Settings; revision: number }> {
  const base = await readPersonalSnapshot(q, '1970-01-01T00:00:00.000Z', 'backup');
  const priceSnapshots = await q.select<PriceRow>(PRICE_COLS, 'FROM price_snapshots ORDER BY id ASC');
  const catalogIdentities = await q.select<Entities['catalogIdentities'][number]>(
    { language: 'language', id: 'id', createdAt: 'created_at' }, 'FROM catalog_identities ORDER BY language ASC, id ASC'
  );
  const annotationRows = await q.select<{ language: 'en' | 'ja'; catalogCardId: string; overrides: string; notes: string | null; createdAt: string; updatedAt: string }>(
    { language: 'language', catalogCardId: 'catalog_card_id', overrides: 'display_overrides_json', notes: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' },
    'FROM catalog_annotations ORDER BY language ASC, catalog_card_id ASC'
  );
  const catalogAnnotations = annotationRows.map((r) => ({
    language: r.language, catalogCardId: r.catalogCardId, displayOverrides: JSON.parse(r.overrides) as Record<string, unknown>, notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt
  }));
  const s = await readSettings(q);
  const settings: Settings = {
    settingsVersion: 1, languages: s.languages, setsFollowed: s.setsFollowed, syncAllSets: s.syncAllSets, hideTcgPocket: s.hideTcgPocket,
    defaultCurrency: s.defaultCurrency, disclaimerAcknowledged: s.disclaimerAcknowledged, disclaimerAcknowledgedAt: s.disclaimerAcknowledgedAt,
    onboardingCompletedAt: s.onboardingCompletedAt, updatedAt: s.updatedAt, imageCacheLimitBytes: DEFAULT_IMAGE_CACHE_LIMIT_BYTES
  };
  const entities: Entities = {
    entitiesVersion: 1, catalogIdentities, catalogRefs: base.catalogRefs, catalogAnnotations, customCards: base.customCards, acquisitions: base.acquisitions,
    storageLocations: base.storageLocations, collectionGroups: base.collectionGroups, scanSessions: base.scanSessions, ownedCards: base.ownedCards,
    grades: base.grades, collectionGroupMembers: base.collectionGroupMembers, priceSnapshots, userImages: []
  };
  return { entities, settings, revision: await readRevision(q) };
}

/** Inputs of userStateToken: collection revision, settings.updatedAt, annotation state (count + max updated_at). */
export async function readUserState(q: Exec): Promise<{ collectionRevision: number; settingsUpdatedAt: string; annotations: { count: number; maxUpdatedAt: string | null } }> {
  const settingsUpdatedAt = String((await q.scalar<string>("SELECT updated_at FROM app_settings WHERE id = 'app'")) ?? '');
  const row = (await q.rows('SELECT COUNT(*), MAX(updated_at) FROM catalog_annotations'))[0];
  return {
    collectionRevision: await readRevision(q), settingsUpdatedAt,
    annotations: { count: Number(row?.[0] ?? 0), maxUpdatedAt: row?.[1] === null || row?.[1] === undefined ? null : String(row[1]) }
  };
}
