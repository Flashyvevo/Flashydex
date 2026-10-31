import type { AcquisitionDto, GradeDto, Language, OwnedDto } from '@flashydex/schemas';
import { chunk, placeholders } from '../db/sql';
import { valuationsFor } from '../domain/valuation';
import { CHUNK, identityKey, loadOfficialCounts, loadQuotes, type ServiceContext } from './context';

type OwnedRow = {
  id: string; catalogCardId: string | null; customCardId: string | null; name: string; setId: string | null; setName: string | null;
  localId: string | null; language: Language; rarity: string | null; imageUrl: string | null; variant: OwnedDto['variant']; variantDetail: string;
  condition: OwnedDto['condition']; acquisitionId: string | null; purchaseCents: number | null; purchaseCurrency: 'USD' | 'EUR' | null;
  storageLocationId: string | null; storageName: string | null; scanSessionId: string | null; notes: string | null;
  manualCents: number | null; manualCurrency: 'USD' | 'EUR' | null; createdAt: string; updatedAt: string; dup: number;
  acqId: string | null; acqPurchasedOn: string | null; acqSource: string | null; acqNotes: string | null; acqCreatedAt: string | null;
  acqUpdatedAt: string | null; acqCount: number | null;
  gradeId: string | null; gradeCompany: GradeDto['company'] | null; gradeLabel: string | null; gradeValue: string | null; gradeCert: string | null;
  gradeNotes: string | null; gradeCreatedAt: string | null; gradeUpdatedAt: string | null;
};

const OWNED_COLS = {
  id: 'o.id', catalogCardId: 'o.catalog_card_id', customCardId: 'o.custom_card_id', name: 'o.name', setId: 'o.set_id', setName: 'o.set_name',
  localId: 'o.local_id', language: 'o.language', rarity: 'o.rarity', imageUrl: 'o.image_url', variant: 'o.variant', variantDetail: 'o.variant_detail',
  condition: 'o.condition', acquisitionId: 'o.acquisition_id', purchaseCents: 'o.purchase_price_cents', purchaseCurrency: 'o.purchase_currency',
  storageLocationId: 'o.storage_location_id', storageName: 's.name', scanSessionId: 'o.scan_session_id', notes: 'o.notes',
  manualCents: 'o.manual_price_cents', manualCurrency: 'o.manual_price_currency', createdAt: 'o.created_at', updatedAt: 'o.updated_at',
  dup: `(SELECT COUNT(*) FROM owned_cards x WHERE x.language = o.language AND x.catalog_card_id IS o.catalog_card_id
    AND x.custom_card_id IS o.custom_card_id AND x.variant = o.variant AND x.variant_detail = o.variant_detail)`,
  acqId: 'a.id', acqPurchasedOn: 'a.purchased_on', acqSource: 'a.source', acqNotes: 'a.notes', acqCreatedAt: 'a.created_at', acqUpdatedAt: 'a.updated_at',
  acqCount: '(SELECT COUNT(*) FROM owned_cards y WHERE y.acquisition_id = a.id)',
  gradeId: 'g.id', gradeCompany: 'g.company', gradeLabel: 'g.company_label', gradeValue: 'g.grade', gradeCert: 'g.cert_number',
  gradeNotes: 'g.notes', gradeCreatedAt: 'g.created_at', gradeUpdatedAt: 'g.updated_at'
} as const;

const OWNED_FROM = `FROM owned_cards o
  LEFT JOIN acquisitions a ON a.id = o.acquisition_id
  LEFT JOIN storage_locations s ON s.id = o.storage_location_id
  LEFT JOIN grades g ON g.owned_card_id = o.id`;

/** Hydrate full OwnedDtos for at most a page of ids (callers never pass an unbounded list; chunked by 100 regardless). */
export function hydrateOwned(ctx: ServiceContext, ids: readonly string[]): Promise<Map<string, OwnedDto>> {
  // E2 / N07: copy hydration reads catalog availability/quotes through whatever handles exist; protect the whole operation.
  return ctx.databases.protectedRead(['en', 'ja'], () => hydrateOwnedOnce(ctx, ids));
}

async function hydrateOwnedOnce(ctx: ServiceContext, ids: readonly string[]): Promise<Map<string, OwnedDto>> {
  const out = new Map<string, OwnedDto>();
  if (ids.length === 0) return out;
  const user = ctx.databases.user;
  const rows: OwnedRow[] = [];
  const groupIds = new Map<string, string[]>();
  await user.read(async (q) => {
    for (const part of chunk([...new Set(ids)], CHUNK)) {
      rows.push(...(await q.select<OwnedRow>(OWNED_COLS, `${OWNED_FROM} WHERE o.id IN (${placeholders(part.length)})`, part)));
      const members = await q.rows(`SELECT owned_card_id, collection_group_id FROM collection_group_members WHERE owned_card_id IN (${placeholders(part.length)}) ORDER BY collection_group_id ASC`, part);
      for (const m of members) {
        const list = groupIds.get(String(m[0])) ?? [];
        list.push(String(m[1]));
        groupIds.set(String(m[0]), list);
      }
    }
  });

  const identities = rows.filter((r) => r.catalogCardId !== null).map((r) => ({ language: r.language, id: r.catalogCardId as string }));
  const quotes = await loadQuotes(ctx, identities);
  const available = await catalogAvailability(ctx, identities);
  const officialCounts = await loadOfficialCounts(ctx, rows.filter((r) => r.catalogCardId !== null && r.setId !== null).map((r) => ({ language: r.language, setId: r.setId as string })));

  for (const r of rows) {
    const graded = r.gradeId !== null;
    const manual = r.manualCents !== null && r.manualCurrency !== null ? { cents: r.manualCents, currency: r.manualCurrency } : null;
    const acquisition: AcquisitionDto | null = r.acqId === null ? null : {
      id: r.acqId, purchasedOn: r.acqPurchasedOn, source: r.acqSource, notes: r.acqNotes, createdAt: r.acqCreatedAt as string,
      updatedAt: r.acqUpdatedAt as string, copyCount: Number(r.acqCount)
    };
    const grade: GradeDto | null = r.gradeId === null ? null : {
      id: r.gradeId, ownedCardId: r.id, company: r.gradeCompany as GradeDto['company'], companyLabel: r.gradeLabel, grade: r.gradeValue as string,
      certNumber: r.gradeCert, notes: r.gradeNotes, createdAt: r.gradeCreatedAt as string, updatedAt: r.gradeUpdatedAt as string
    };
    out.set(r.id, {
      id: r.id, catalogCardId: r.catalogCardId, customCardId: r.customCardId, name: r.name, setId: r.setId, setName: r.setName, localId: r.localId,
      language: r.language, rarity: r.rarity, imageUrl: r.imageUrl, variant: r.variant, variantDetail: r.variantDetail, condition: r.condition,
      acquisitionId: r.acquisitionId, acquisition,
      purchasePrice: r.purchaseCents !== null && r.purchaseCurrency !== null ? { cents: r.purchaseCents, currency: r.purchaseCurrency } : null,
      storageLocationId: r.storageLocationId, storageLocationName: r.storageName, scanSessionId: r.scanSessionId, notes: r.notes,
      manualPrice: manual, grade, groupIds: groupIds.get(r.id) ?? [], duplicateCount: Number(r.dup),
      valuations: valuationsFor(
        { variant: r.variant, variantDetail: r.variantDetail, graded, manual, updatedAt: r.updatedAt },
        r.catalogCardId === null ? [] : (quotes.get(identityKey(r.language, r.catalogCardId)) ?? [])
      ),
      catalogAvailable: r.catalogCardId !== null && available.has(identityKey(r.language, r.catalogCardId)),
      setOfficialCount: r.setId === null ? null : (officialCounts.get(identityKey(r.language, r.setId)) ?? null),
      createdAt: r.createdAt, updatedAt: r.updatedAt
    });
  }
  return out;
}

/** Which of these catalog ids exist in the installed catalog (never throws on a missing catalog). */
export async function catalogAvailability(ctx: ServiceContext, identities: ReadonlyArray<{ language: Language; id: string }>): Promise<Set<string>> {
  const out = new Set<string>();
  const byLanguage = new Map<Language, string[]>();
  for (const i of identities) byLanguage.set(i.language, [...(byLanguage.get(i.language) ?? []), i.id]);
  for (const [language, ids] of byLanguage) {
    let catalog;
    try {
      catalog = await ctx.databases.catalog(language);
    } catch {
      continue;
    }
    if (!catalog) continue;
    for (const part of chunk([...new Set(ids)], CHUNK)) {
      const rows = await catalog.rows(`SELECT id FROM catalog_cards WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part]);
      rows.forEach((r) => out.add(identityKey(language, String(r[0]))));
    }
  }
  return out;
}
