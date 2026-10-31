import {
  EXPORT_ENTITIES, type CollectionExportV1, type ExportEntityName, type ImportIssue
} from '@flashydex/schemas';
import { sha256Hex } from '../catalog/sha256';
import { nameKeyOf } from '../services/context';

type Doc = CollectionExportV1;
export type Action = 'create' | 'update' | 'skip';
export type PlanRow<T> = { action: Action; row: T; changedFields: string[] };
export type PlanEntities = { [K in ExportEntityName]: Array<PlanRow<Doc[K] extends Array<infer R> ? R : never>> };
export type Plan = {
  entities: PlanEntities;
  /** Existing child rows the plan removes (authoritative `update` of a copy). */
  removals: { grades: string[]; members: Array<{ collectionGroupId: string; ownedCardId: string }> };
};
export type Counts = Record<'read' | 'create' | 'update' | 'skip' | 'error', number>;

export type DbState = {
  doc: Doc; // the CURRENT personal snapshot (see readPersonalSnapshot)
  ledger: Set<string>; // `${language}\0${id}` of existing catalog_identities
  priceById: Map<string, Doc['priceSnapshots'][number]>;
  priceByKey: Map<string, string>; // observationKey -> id
  catalogCached: (language: 'en' | 'ja', id: string) => boolean;
};

export const ledgerKey = (language: string, id: string): string => `${language}\u0000${id}`;

/** Recursively key-sorted canonical JSON (no whitespace). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/** SHA-256 of the UTF-8 JSON array `[language,catalogCardId,source,variant,variantDetail,providerVariantKey,currency,sourceUpdatedAt,low,mid,high,market,trend]`. */
export const observationKeyOf = (p: Doc['priceSnapshots'][number]): string =>
  sha256Hex(JSON.stringify([p.language, p.catalogCardId, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.sourceUpdatedAt, p.lowCents, p.midCents, p.highCents, p.marketCents, p.trendCents]));

const ENTITY_ORDER = EXPORT_ENTITIES;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const diff = (a: Record<string, unknown>, b: Record<string, unknown>): string[] => Object.keys(a).filter((k) => k !== 'id' && !same(a[k], b[k]));

export type Built = {
  plan: Plan;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  errorCount: number;
  warningCount: number;
  counts: Record<ExportEntityName, Counts>;
};

/**
 * Decide create/update/skip/error for every normalized entity row against current state. Pure: no I/O.
 * `invalid` marks rows that failed per-row schema validation earlier (counted as errors, excluded from the plan).
 */
export function buildPlan(
  doc: Doc, policy: 'skip' | 'update', state: DbState, invalid: Partial<Record<ExportEntityName, number>>,
  rowMap: Partial<Record<ExportEntityName, number[]>>, pre: ImportIssue[], preWarnings: ImportIssue[]
): Built {
  const errors: ImportIssue[] = [...pre];
  const warnings: ImportIssue[] = [...preWarnings];
  const errorRows = new Map<ExportEntityName, Set<number>>();
  /** 1-based row number in the ORIGINAL file (rows that failed per-row validation were removed from `doc`). */
  const rowOf = (entity: ExportEntityName, index: number): number => (rowMap[entity]?.[index] ?? index) + 1;
  const markError = (entity: ExportEntityName, index: number, id: string | null, code: string, message: string, path: Array<string | number> = []) => {
    errors.push({ entity, row: rowOf(entity, index), id, code, message, path });
    const set = errorRows.get(entity) ?? new Set<number>();
    set.add(index);
    errorRows.set(entity, set);
  };
  const warn = (entity: ExportEntityName, index: number, id: string | null, code: string, message: string) => warnings.push({ entity, row: rowOf(entity, index), id, code, message, path: [] });

  const cur = state.doc;
  const fileIds = <K extends ExportEntityName>(entity: K) => new Set((doc[entity] as Array<{ id: string }>).map((r) => r.id));
  const curById = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const existing = {
    custom: curById(cur.customCards), acq: curById(cur.acquisitions), loc: curById(cur.storageLocations), grp: curById(cur.collectionGroups),
    sess: curById(cur.scanSessions), owned: curById(cur.ownedCards)
  };
  const inFile = { custom: fileIds('customCards'), acq: fileIds('acquisitions'), loc: fileIds('storageLocations'), grp: fileIds('collectionGroups'), sess: fileIds('scanSessions'), owned: fileIds('ownedCards') };
  const fileRefs = new Set(doc.catalogRefs.map((r) => ledgerKey(r.language, r.id)));
  const known = (set: Set<string>, map: Map<string, unknown>, id: string) => set.has(id) || map.has(id);

  // ---- duplicate primary keys inside the file
  const dup = (entity: ExportEntityName, keys: string[]) => {
    const seen = new Set<string>();
    keys.forEach((k, i) => { if (seen.has(k)) markError(entity, i, k, 'DUPLICATE_ID', 'Duplicate key in the file'); seen.add(k); });
  };
  dup('catalogRefs', doc.catalogRefs.map((r) => ledgerKey(r.language, r.id)));
  dup('customCards', doc.customCards.map((r) => r.id));
  dup('acquisitions', doc.acquisitions.map((r) => r.id));
  dup('storageLocations', doc.storageLocations.map((r) => r.id));
  dup('collectionGroups', doc.collectionGroups.map((r) => r.id));
  dup('scanSessions', doc.scanSessions.map((r) => r.id));
  dup('ownedCards', doc.ownedCards.map((r) => r.id));
  dup('grades', doc.grades.map((r) => r.id));
  dup('grades', doc.grades.map((r) => r.ownedCardId));
  dup('collectionGroupMembers', doc.collectionGroupMembers.map((m) => `${m.collectionGroupId}\u0000${m.ownedCardId}`));
  dup('priceSnapshots', doc.priceSnapshots.map((r) => r.id));

  // ---- name collisions among parents (normalized unique names)
  for (const [entity, rows, existingRows] of [['storageLocations', doc.storageLocations, cur.storageLocations], ['collectionGroups', doc.collectionGroups, cur.collectionGroups]] as const) {
    const byKey = new Map<string, string>();
    rows.forEach((r, i) => {
      const key = nameKeyOf(r.name);
      const prior = byKey.get(key);
      if (prior !== undefined && prior !== r.id) markError(entity, i, r.id, 'NAME_CONFLICT', 'Two different entries share a normalized name');
      byKey.set(key, r.id);
      const clash = existingRows.find((e) => nameKeyOf(e.name) === key && e.id !== r.id);
      if (clash) markError(entity, i, r.id, 'NAME_CONFLICT', 'An existing entry with a different id has the same normalized name');
    });
  }

  // ---- per-row semantic validation
  doc.scanSessions.forEach((s, i) => {
    if ((s.status === 'open') !== (s.endedAt === null)) markError('scanSessions', i, s.id, 'INVALID_SESSION', 'endedAt must be set exactly when the session is not open');
    if (s.endedAt !== null && s.endedAt < s.startedAt) markError('scanSessions', i, s.id, 'INVALID_SESSION', 'endedAt is before startedAt');
  });
  doc.catalogRefs.forEach((r, i) => { if (r.localId === '' || r.setId === '') markError('catalogRefs', i, r.id, 'INVALID_REF', 'setId and localId are required'); });
  doc.ownedCards.forEach((c, i) => {
    if ((c.catalogCardId === null) === (c.customCardId === null)) markError('ownedCards', i, c.id, 'INVALID_SOURCE', 'Exactly one of catalogCardId/customCardId is required', ['catalogCardId']);
    if (c.catalogCardId !== null && (c.setId === null || c.localId === null)) markError('ownedCards', i, c.id, 'INVALID_SNAPSHOT', 'Catalog copies need setId and localId', ['setId']);
    if (c.variant === 'other' && c.variantDetail.trim() === '') markError('ownedCards', i, c.id, 'INVALID_VARIANT', "variant 'other' requires a variantDetail", ['variantDetail']);
    if ((c.purchasePriceCents === null) !== (c.purchaseCurrency === null)) markError('ownedCards', i, c.id, 'PARTIAL_MONEY', 'purchase price and currency must be set together', ['purchasePriceCents']);
    if ((c.manualPriceCents === null) !== (c.manualPriceCurrency === null)) markError('ownedCards', i, c.id, 'PARTIAL_MONEY', 'manual price and currency must be set together', ['manualPriceCents']);
    if (c.updatedAt < c.createdAt) markError('ownedCards', i, c.id, 'INVALID_TIMESTAMP', 'updatedAt is before createdAt');
    if (c.customCardId !== null) {
      if (!known(inFile.custom, existing.custom, c.customCardId)) markError('ownedCards', i, c.id, 'REFERENCE_MISSING', 'customCardId is not defined in the file or the collection', ['customCardId']);
      else {
        const custom = doc.customCards.find((x) => x.id === c.customCardId) ?? existing.custom.get(c.customCardId);
        if (custom && custom.language !== c.language) markError('ownedCards', i, c.id, 'LANGUAGE_MISMATCH', 'The custom card language differs from the copy language', ['language']);
      }
    }
    if (c.catalogCardId !== null && !fileRefs.has(ledgerKey(c.language, c.catalogCardId)) && !state.ledger.has(ledgerKey(c.language, c.catalogCardId))) {
      markError('ownedCards', i, c.id, 'REFERENCE_MISSING', 'catalogCardId has no catalogRefs entry', ['catalogCardId']);
    }
    if (c.acquisitionId !== null && !known(inFile.acq, existing.acq, c.acquisitionId)) markError('ownedCards', i, c.id, 'REFERENCE_MISSING', 'acquisitionId is not defined', ['acquisitionId']);
    if (c.storageLocationId !== null && !known(inFile.loc, existing.loc, c.storageLocationId)) markError('ownedCards', i, c.id, 'REFERENCE_MISSING', 'storageLocationId is not defined', ['storageLocationId']);
    if (c.scanSessionId !== null && !known(inFile.sess, existing.sess, c.scanSessionId)) markError('ownedCards', i, c.id, 'REFERENCE_MISSING', 'scanSessionId is not defined', ['scanSessionId']);
  });
  doc.grades.forEach((g, i) => {
    if ((g.company === 'other') !== (g.companyLabel !== null)) markError('grades', i, g.id, 'INVALID_GRADE', "companyLabel is required exactly when company is 'other'", ['companyLabel']);
    if (g.updatedAt < g.createdAt) markError('grades', i, g.id, 'INVALID_TIMESTAMP', 'updatedAt is before createdAt');
    if (!known(inFile.owned, existing.owned, g.ownedCardId)) markError('grades', i, g.id, 'REFERENCE_MISSING', 'ownedCardId is not defined', ['ownedCardId']);
  });
  doc.collectionGroupMembers.forEach((m, i) => {
    if (!known(inFile.grp, existing.grp, m.collectionGroupId)) markError('collectionGroupMembers', i, m.collectionGroupId, 'REFERENCE_MISSING', 'collectionGroupId is not defined', ['collectionGroupId']);
    if (!known(inFile.owned, existing.owned, m.ownedCardId)) markError('collectionGroupMembers', i, m.ownedCardId, 'REFERENCE_MISSING', 'ownedCardId is not defined', ['ownedCardId']);
  });
  doc.priceSnapshots.forEach((p, i) => {
    if ((p.source === 'tcgplayer') !== (p.currency === 'USD') || (p.source === 'cardmarket') !== (p.currency === 'EUR')) markError('priceSnapshots', i, p.id, 'INVALID_PRICE', 'source and currency do not pair (tcgplayer=USD, cardmarket=EUR)');
    if (observationKeyOf(p) !== p.observationKey) markError('priceSnapshots', i, p.id, 'INVALID_OBSERVATION_KEY', 'observationKey does not match the observation', ['observationKey']);
    if (!fileRefs.has(ledgerKey(p.language, p.catalogCardId)) && !state.ledger.has(ledgerKey(p.language, p.catalogCardId))) markError('priceSnapshots', i, p.id, 'REFERENCE_MISSING', 'No catalogRefs entry for this price', ['catalogCardId']);
  });

  const isErr = (entity: ExportEntityName, index: number) => errorRows.get(entity)?.has(index) === true;

  // ---- conflict resolution -> actions
  const plan: Plan = {
    entities: { catalogRefs: [], customCards: [], acquisitions: [], storageLocations: [], collectionGroups: [], scanSessions: [], ownedCards: [], grades: [], collectionGroupMembers: [], priceSnapshots: [] },
    removals: { grades: [], members: [] }
  };
  const counts = Object.fromEntries(ENTITY_ORDER.map((e) => [e, { read: 0, create: 0, update: 0, skip: 0, error: 0 }])) as Record<ExportEntityName, Counts>;
  const record = <E extends ExportEntityName>(entity: E, index: number, row: PlanEntities[E][number]['row'], action: Action, changedFields: string[] = []) => {
    (plan.entities[entity] as Array<PlanRow<unknown>>).push({ action, row, changedFields });
    counts[entity][action] += 1;
    void index;
  };
  const generic = <E extends 'customCards' | 'acquisitions' | 'storageLocations' | 'collectionGroups' | 'scanSessions'>(entity: E, rows: Array<{ id: string } & Record<string, unknown>>, current: Map<string, { id: string }>) => {
    rows.forEach((row, index) => {
      if (isErr(entity, index)) return;
      const prior = current.get(row.id) as ({ id: string } & Record<string, unknown>) | undefined;
      if (!prior) return record(entity, index, row as never, 'create');
      const changed = diff(row, prior);
      if (changed.length === 0 || policy === 'skip') return record(entity, index, row as never, 'skip');
      if (entity === 'customCards' && row.language !== prior.language && cur.ownedCards.some((c) => c.customCardId === row.id)) {
        return markError(entity, index, row.id, 'REFERENCE_CONFLICT', 'The language of a custom card that has copies cannot change');
      }
      return record(entity, index, row as never, 'update', changed);
    });
  };
  // catalogRefs (identity ledger)
  doc.catalogRefs.forEach((r, index) => {
    if (isErr('catalogRefs', index)) return;
    if (state.ledger.has(ledgerKey(r.language, r.id))) return record('catalogRefs', index, r, 'skip');
    if (!state.catalogCached(r.language, r.id)) warn('catalogRefs', index, r.id, 'CATALOG_METADATA_MISSING', 'This card is not in the installed catalog; its snapshot is kept as a reference only');
    return record('catalogRefs', index, r, 'create');
  });
  generic('customCards', doc.customCards, existing.custom);
  generic('acquisitions', doc.acquisitions, existing.acq);
  generic('storageLocations', doc.storageLocations, existing.loc);
  generic('collectionGroups', doc.collectionGroups, existing.grp);
  generic('scanSessions', doc.scanSessions, existing.sess);

  // owned copies + their authoritative children
  const fileGradeByOwner = new Map(doc.grades.map((g, i) => [g.ownedCardId, { g, i }]));
  const fileMembersByOwner = new Map<string, Array<{ m: Doc['collectionGroupMembers'][number]; i: number }>>();
  doc.collectionGroupMembers.forEach((m, i) => fileMembersByOwner.set(m.ownedCardId, [...(fileMembersByOwner.get(m.ownedCardId) ?? []), { m, i }]));
  const curGradeByOwner = new Map(cur.grades.map((g) => [g.ownedCardId, g]));
  const curGradeOwnerById = new Map(cur.grades.map((g) => [g.id, g.ownedCardId]));
  const curMembersByOwner = new Map<string, string[]>();
  cur.collectionGroupMembers.forEach((m) => curMembersByOwner.set(m.ownedCardId, [...(curMembersByOwner.get(m.ownedCardId) ?? []), m.collectionGroupId]));
  const ownedAction = new Map<string, Action>();

  doc.ownedCards.forEach((row, index) => {
    if (isErr('ownedCards', index)) return;
    const prior = existing.owned.get(row.id);
    if (!prior) { ownedAction.set(row.id, 'create'); return record('ownedCards', index, row, 'create'); }
    const changed = diff(row, prior);
    // child differences matter only for an authoritative update
    const fileGrade = fileGradeByOwner.get(row.id)?.g ?? null;
    const curGrade = curGradeByOwner.get(row.id) ?? null;
    const gradeChanged = !same(fileGrade, curGrade);
    const fileGroups = (fileMembersByOwner.get(row.id) ?? []).map((x) => x.m.collectionGroupId).sort();
    const curGroups = (curMembersByOwner.get(row.id) ?? []).slice().sort();
    const groupsChanged = !same(fileGroups, curGroups);
    if (policy === 'skip' || (changed.length === 0 && !gradeChanged && !groupsChanged)) { ownedAction.set(row.id, 'skip'); return record('ownedCards', index, row, 'skip'); }
    const fields = [...changed, ...(gradeChanged ? ['grade'] : []), ...(groupsChanged ? ['groupIds'] : [])];
    ownedAction.set(row.id, 'update');
    if (curGrade && (!fileGrade || fileGrade.id !== curGrade.id)) plan.removals.grades.push(curGrade.id);
    for (const gid of curGroups) if (!fileGroups.includes(gid)) plan.removals.members.push({ collectionGroupId: gid, ownedCardId: row.id });
    return record('ownedCards', index, row, 'update', fields);
  });

  doc.grades.forEach((g, index) => {
    if (isErr('grades', index)) return;
    const owner = ownedAction.get(g.ownedCardId);
    const holder = curGradeOwnerById.get(g.id);
    if (holder !== undefined && holder !== g.ownedCardId) return markError('grades', index, g.id, 'REFERENCE_CONFLICT', 'This grade id already belongs to another copy', ['id']);
    if (owner === 'skip') return record('grades', index, g, 'skip');
    const prior = cur.grades.find((x) => x.id === g.id);
    if (owner === 'create' || !prior) {
      if (owner !== 'create' && curGradeByOwner.has(g.ownedCardId) && policy === 'skip') return record('grades', index, g, 'skip');
      return record('grades', index, g, 'create');
    }
    const changed = diff(g, prior);
    return changed.length === 0 ? record('grades', index, g, 'skip') : record('grades', index, g, owner === 'update' || policy === 'update' ? 'update' : 'skip', changed);
  });
  doc.collectionGroupMembers.forEach((m, index) => {
    if (isErr('collectionGroupMembers', index)) return;
    const owner = ownedAction.get(m.ownedCardId);
    if (owner === 'skip') return record('collectionGroupMembers', index, m, 'skip');
    const present = (curMembersByOwner.get(m.ownedCardId) ?? []).includes(m.collectionGroupId);
    return record('collectionGroupMembers', index, m, present ? 'skip' : 'create');
  });

  doc.priceSnapshots.forEach((p, index) => {
    if (isErr('priceSnapshots', index)) return;
    const byId = state.priceById.get(p.id);
    if (byId) {
      if (same(byId, p)) return record('priceSnapshots', index, p, 'skip');
      return markError('priceSnapshots', index, p.id, 'PRICE_IMMUTABLE', 'A price observation with this id already exists with different content');
    }
    if (state.priceByKey.has(p.observationKey)) return record('priceSnapshots', index, p, 'skip');
    return record('priceSnapshots', index, p, 'create');
  });

  // error rows (per-row schema failures + flagged rows) complete the partition read = create + update + skip + error
  for (const entity of ENTITY_ORDER) {
    counts[entity].error = (errorRows.get(entity)?.size ?? 0) + (invalid[entity] ?? 0);
    counts[entity].read = counts[entity].create + counts[entity].update + counts[entity].skip + counts[entity].error;
  }
  return { plan, errors: errors.slice(0, 100), warnings: warnings.slice(0, 100), errorCount: errors.length, warningCount: warnings.length, counts };
}
