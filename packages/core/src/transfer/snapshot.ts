import type { CollectionExportV1 } from '@flashydex/schemas';
import { chunk, placeholders, type Exec } from '../db/sql';

type Doc = CollectionExportV1;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Personal rows from ONE consistent user-DB read (call inside `db.read`). Catalog tables are never consulted. */
export async function readPersonalSnapshot(q: Exec, exportedAt: string, appVersion: string): Promise<Doc> {
  const customCards = await q.select<Doc['customCards'][number]>(
    { id: 'id', name: 'name', setId: 'set_id', setName: 'set_name', localId: 'local_id', language: 'language', rarity: 'rarity', imageUrl: 'image_url', notes: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' },
    'FROM custom_cards ORDER BY id ASC'
  );
  const acquisitions = await q.select<Doc['acquisitions'][number]>(
    { id: 'id', purchasedOn: 'purchased_on', source: 'source', notes: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' }, 'FROM acquisitions ORDER BY id ASC'
  );
  const storageLocations = await q.select<Doc['storageLocations'][number]>(
    { id: 'id', name: 'name', description: 'description', createdAt: 'created_at', updatedAt: 'updated_at' }, 'FROM storage_locations ORDER BY id ASC'
  );
  const collectionGroups = await q.select<Doc['collectionGroups'][number]>(
    { id: 'id', name: 'name', description: 'description', createdAt: 'created_at', updatedAt: 'updated_at' }, 'FROM collection_groups ORDER BY id ASC'
  );
  const scanSessions = await q.select<Doc['scanSessions'][number]>(
    { id: 'id', status: 'status', startedAt: 'started_at', endedAt: 'ended_at', notes: 'notes' }, 'FROM scan_sessions ORDER BY id ASC'
  );
  const ownedCards = await q.select<Doc['ownedCards'][number]>(
    {
      id: 'id', catalogCardId: 'catalog_card_id', customCardId: 'custom_card_id', name: 'name', setId: 'set_id', setName: 'set_name', localId: 'local_id',
      language: 'language', rarity: 'rarity', imageUrl: 'image_url', variant: 'variant', variantDetail: 'variant_detail', condition: 'condition',
      acquisitionId: 'acquisition_id', purchasePriceCents: 'purchase_price_cents', purchaseCurrency: 'purchase_currency', storageLocationId: 'storage_location_id',
      scanSessionId: 'scan_session_id', notes: 'notes', manualPriceCents: 'manual_price_cents', manualPriceCurrency: 'manual_price_currency',
      createdAt: 'created_at', updatedAt: 'updated_at'
    },
    'FROM owned_cards ORDER BY id ASC'
  );
  const grades = await q.select<Doc['grades'][number]>(
    { id: 'id', ownedCardId: 'owned_card_id', company: 'company', companyLabel: 'company_label', grade: 'grade', certNumber: 'cert_number', notes: 'notes', createdAt: 'created_at', updatedAt: 'updated_at' },
    'FROM grades ORDER BY id ASC'
  );
  const members = await q.select<Doc['collectionGroupMembers'][number]>(
    { collectionGroupId: 'collection_group_id', ownedCardId: 'owned_card_id' }, 'FROM collection_group_members ORDER BY collection_group_id ASC, owned_card_id ASC'
  );

  // Catalog refs: one deterministic snapshot per owned catalog identity (smallest owned UUID).
  const refs = new Map<string, Doc['catalogRefs'][number]>();
  for (const c of ownedCards) {
    if (c.catalogCardId === null) continue;
    const key = `${c.language}\u0000${c.catalogCardId}`;
    if (refs.has(key)) continue; // ownedCards is ordered by id ASC: first seen has the smallest UUID
    refs.set(key, { id: c.catalogCardId, language: c.language, name: c.name, setId: c.setId as string, setName: c.setName, localId: c.localId as string, rarity: c.rarity, imageUrl: c.imageUrl });
  }
  const catalogRefs = [...refs.values()].sort((a, b) => cmp(a.language, b.language) || cmp(a.id, b.id));

  // Full history for referenced identities only.
  const priceSnapshots: Doc['priceSnapshots'] = [];
  const byLanguage = new Map<string, string[]>();
  for (const r of catalogRefs) byLanguage.set(r.language, [...(byLanguage.get(r.language) ?? []), r.id]);
  for (const [language, ids] of byLanguage) {
    for (const part of chunk(ids, 100)) {
      priceSnapshots.push(...(await q.select<Doc['priceSnapshots'][number]>(
        {
          id: 'id', catalogCardId: 'catalog_card_id', language: 'language', source: 'source', variant: 'variant', variantDetail: 'variant_detail',
          providerVariantKey: 'provider_variant_key', currency: 'currency', lowCents: 'low_cents', midCents: 'mid_cents', highCents: 'high_cents',
          marketCents: 'market_cents', trendCents: 'trend_cents', sourceUpdatedAt: 'source_updated_at', capturedAt: 'captured_at', observationKey: 'observation_key'
        },
        `FROM price_snapshots WHERE language = ? AND catalog_card_id IN (${placeholders(part.length)})`, [language, ...part]
      )));
    }
  }
  priceSnapshots.sort((a, b) => cmp(a.id, b.id));

  return {
    schemaVersion: 1, exportedAt, appVersion, catalogRefs, customCards, acquisitions, storageLocations, collectionGroups, scanSessions, ownedCards, grades,
    collectionGroupMembers: members, priceSnapshots
  };
}
