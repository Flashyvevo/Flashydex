import type { CollectionExportV1 } from '@flashydex/schemas';
import { CSV_COLUMNS, escapeFormula, isTextColumn, serializeCsv, type CsvColumn } from './csv';

type Doc = CollectionExportV1;

/** One row per physical copy, the exact 45 ordered columns, RFC 4180, BOM, CRLF, reversible formula escape on text cells. */
export function buildCsv(doc: Doc): { csv: string; warnings: string[] } {
  const acquisitions = new Map(doc.acquisitions.map((r) => [r.id, r]));
  const locations = new Map(doc.storageLocations.map((r) => [r.id, r]));
  const groups = new Map(doc.collectionGroups.map((r) => [r.id, r]));
  const customs = new Map(doc.customCards.map((r) => [r.id, r]));
  const sessions = new Map(doc.scanSessions.map((r) => [r.id, r]));
  const grades = new Map(doc.grades.map((r) => [r.ownedCardId, r]));
  const membership = new Map<string, string[]>();
  for (const m of doc.collectionGroupMembers) membership.set(m.ownedCardId, [...(membership.get(m.ownedCardId) ?? []), m.collectionGroupId]);

  const warnings: string[] = [
    'CSV cannot preserve unreferenced locations, groups, purchases, custom cards or scan sessions, nor price history. Use JSON for a complete transfer.'
  ];
  let diverged = 0;
  const rows: string[][] = [[...CSV_COLUMNS]];
  for (const c of doc.ownedCards) {
    const acq = c.acquisitionId ? acquisitions.get(c.acquisitionId) : undefined;
    const loc = c.storageLocationId ? locations.get(c.storageLocationId) : undefined;
    const custom = c.customCardId ? customs.get(c.customCardId) : undefined;
    const session = c.scanSessionId ? sessions.get(c.scanSessionId) : undefined;
    const grade = grades.get(c.id);
    const groupIds = (membership.get(c.id) ?? []).slice().sort();
    const gs = groupIds.map((id) => groups.get(id)).filter((g): g is NonNullable<typeof g> => g !== undefined);
    if (custom && (custom.name !== c.name || custom.setId !== c.setId || custom.localId !== c.localId || custom.rarity !== c.rarity)) diverged += 1;
    const cells: Record<CsvColumn, string | null> = {
      owned_card_id: c.id, catalog_card_id: c.catalogCardId, custom_card_id: c.customCardId, name: c.name, set_id: c.setId, set_name: c.setName,
      local_id: c.localId, language: c.language, rarity: c.rarity, image_url: c.imageUrl, variant: c.variant, variant_detail: c.variantDetail,
      condition: c.condition, acquisition_id: c.acquisitionId, purchase_date: acq?.purchasedOn ?? null, purchase_source: acq?.source ?? null,
      acquisition_notes: acq?.notes ?? null, purchase_price_cents: c.purchasePriceCents === null ? null : String(c.purchasePriceCents),
      purchase_currency: c.purchaseCurrency, storage_location_id: c.storageLocationId, storage_location_name: loc?.name ?? null,
      storage_location_description: loc?.description ?? null, group_ids: JSON.stringify(gs.map((g) => g.id)), group_names: JSON.stringify(gs.map((g) => g.name)),
      group_descriptions: JSON.stringify(gs.map((g) => g.description)), is_graded: grade ? 'true' : 'false', grade_id: grade?.id ?? null,
      grading_company: grade?.company ?? null, grading_company_label: grade?.companyLabel ?? null, grade: grade?.grade ?? null, cert_number: grade?.certNumber ?? null,
      grade_notes: grade?.notes ?? null, manual_price_cents: c.manualPriceCents === null ? null : String(c.manualPriceCents), manual_price_currency: c.manualPriceCurrency,
      notes: c.notes, custom_card_notes: custom?.notes ?? null, custom_card_created_at: custom?.createdAt ?? null, custom_card_updated_at: custom?.updatedAt ?? null,
      scan_session_id: c.scanSessionId, scan_session_status: session?.status ?? null, scan_session_started_at: session?.startedAt ?? null,
      scan_session_ended_at: session?.endedAt ?? null, scan_session_notes: session?.notes ?? null, created_at: c.createdAt, updated_at: c.updatedAt
    };
    rows.push(CSV_COLUMNS.map((column) => {
      const value = cells[column];
      if (value === null) return '';
      return isTextColumn(column) ? escapeFormula(value) : value;
    }));
  }
  if (diverged > 0) warnings.push(`${diverged} custom-card copies differ from their definition; CSV carries the copy snapshot.`);
  return { csv: serializeCsv(rows), warnings };
}
