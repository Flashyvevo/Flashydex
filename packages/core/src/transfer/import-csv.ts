import {
  Company, Condition, Currency, DateOnly, Id, Instant, Language, Variant, type CollectionExportV1, type ImportIssue
} from '@flashydex/schemas';
import { nameKeyOf } from '../services/context';
import { ImportError } from '../errors';
import { CSV_COLUMNS, CsvSyntaxError, isTextColumn, parseCsv, unescapeFormula, type CsvColumn } from './csv';

type Doc = CollectionExportV1;
const KNOWN = new Set<string>(CSV_COLUMNS);

export type CsvResolver = {
  /** Cached catalog card by exact id+language (null when no catalog / not cached). */
  byId(language: 'en' | 'ja', id: string): Promise<{ setId: string; localId: string } | null>;
  /** Exact (set_id, local_id, language) lookups: every cached match. */
  byTriple(language: 'en' | 'ja', setId: string, localId: string): Promise<string[]>;
  /** Existing target parents by normalized unique name. */
  locationByName(nameKey: string): Promise<string | null>;
  groupByName(nameKey: string): Promise<string | null>;
};

export type CsvOutcome = { doc: Doc; issues: ImportIssue[]; warnings: ImportIssue[]; read: number };

const parseOr = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, value: string): T | undefined => {
  const r = schema.safeParse(value);
  return r.success ? (r.data as T) : undefined;
};

/** CSV -> the same normalized entity arrays a JSON file carries. All generated ids/timestamps are decided HERE and persisted in the plan. */
export async function csvToEntities(text: string, ctx: { now: string; uuid: () => string; resolver: CsvResolver }): Promise<CsvOutcome> {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (error) {
    throw new ImportError('INVALID_CSV', error instanceof CsvSyntaxError ? error.message : 'The CSV file could not be parsed');
  }
  if (table.length === 0) throw new ImportError('INVALID_CSV', 'The CSV file is empty');
  const header = table[0] as string[];
  const seenHeader = new Set<string>();
  for (const h of header) {
    if (!KNOWN.has(h)) throw new ImportError('INVALID_CSV', `Unknown column: ${h}`);
    if (seenHeader.has(h)) throw new ImportError('INVALID_CSV', `Duplicate column: ${h}`);
    seenHeader.add(h);
  }
  for (const required of ['name', 'language', 'variant']) if (!seenHeader.has(required)) throw new ImportError('INVALID_CSV', `Missing required column: ${required}`);

  const doc: Doc = {
    schemaVersion: 1, exportedAt: ctx.now, appVersion: 'csv-import', catalogRefs: [], customCards: [], acquisitions: [], storageLocations: [], collectionGroups: [],
    scanSessions: [], ownedCards: [], grades: [], collectionGroupMembers: [], priceSnapshots: []
  };
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const issue = (list: ImportIssue[], entity: ImportIssue['entity'], row: number, id: string | null, code: string, message: string, path: Array<string | number> = []) =>
    list.push({ entity, row, id, code, message, path });

  const customDefs = new Map<string, Doc['customCards'][number]>();
  const implicitCustoms = new Map<string, string>();
  const acqDefs = new Map<string, Doc['acquisitions'][number]>();
  const locDefs = new Map<string, Doc['storageLocations'][number]>();
  const locByName = new Map<string, string>();
  const groupDefs = new Map<string, Doc['collectionGroups'][number]>();
  const groupByName = new Map<string, string>();
  const sessionDefs = new Map<string, Doc['scanSessions'][number]>();
  const refs = new Map<string, Doc['catalogRefs'][number]>();
  const ownedIds = new Set<string>();
  const gradeIds = new Set<string>();

  const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  for (let r = 1; r < table.length; r += 1) {
    const rowNo = r; // 1-based data row (header excluded)
    const line = table[r] as string[];
    const cell = (column: CsvColumn): string | null => {
      const index = header.indexOf(column);
      if (index < 0) return null;
      const raw = line[index] as string;
      if (raw === '') return null;
      return isTextColumn(column) ? unescapeFormula(raw) : raw;
    };
    const err = (code: string, message: string, path: string[] = []) => issue(issues, 'ownedCards', rowNo, cell('owned_card_id'), code, message, path);
    const before = issues.length;

    const language = parseOr(Language, cell('language') ?? '');
    const variant = parseOr(Variant, cell('variant') ?? '');
    if (!language) err('INVALID_ENUM', 'language must be en or ja', ['language']);
    if (!variant) err('INVALID_ENUM', 'variant is not a supported variant', ['variant']);
    const name = cell('name');
    if (!name || name.trim() === '') err('REQUIRED', 'name is required', ['name']);

    const rawOwnedId = cell('owned_card_id');
    let ownedId = rawOwnedId;
    if (ownedId !== null && !Id.safeParse(ownedId).success) { err('INVALID_ID', 'owned_card_id is not a valid UUID', ['owned_card_id']); ownedId = null; }
    if (ownedId !== null) {
      if (ownedIds.has(ownedId)) err('DUPLICATE_ID', 'owned_card_id appears more than once in the file', ['owned_card_id']);
      ownedIds.add(ownedId);
    }
    const id = ownedId ?? ctx.uuid();

    const catalogId = cell('catalog_card_id');
    let customId = cell('custom_card_id');
    if (catalogId !== null && customId !== null) err('INVALID_SOURCE', 'catalog_card_id and custom_card_id are both set', ['catalog_card_id']);
    if (customId !== null && !Id.safeParse(customId).success) { err('INVALID_ID', 'custom_card_id is not a valid UUID', ['custom_card_id']); customId = null; }
    const setId = cell('set_id');
    const localId = cell('local_id');
    const setName = cell('set_name');
    const rarity = cell('rarity');
    const imageUrl = cell('image_url');

    // --- source resolution (never by name alone, never normalizing zeros, never inferring language)
    let finalCatalogId: string | null = null;
    let finalCustomId: string | null = null;
    if (language && issues.length === before) {
      if (catalogId !== null) {
        const cached = await ctx.resolver.byId(language, catalogId);
        if (cached) {
          if ((setId !== null && setId !== cached.setId) || (localId !== null && localId !== cached.localId)) err('CATALOG_CONFLICT', 'set_id/local_id disagree with the cached catalog card', ['catalog_card_id']);
          else finalCatalogId = catalogId;
        } else if (setId === null || localId === null) err('CATALOG_METADATA_MISSING', 'set_id and local_id are required when the catalog card is not available offline', ['set_id']);
        else {
          const hits = await ctx.resolver.byTriple(language, setId, localId);
          if (hits.length > 0 && !hits.includes(catalogId)) err('CATALOG_CONFLICT', 'set_id/local_id resolve to a different catalog card', ['catalog_card_id']);
          else finalCatalogId = catalogId;
        }
        if (finalCatalogId !== null && !refs.has(`${language}\u0000${finalCatalogId}`) && name) {
          refs.set(`${language}\u0000${finalCatalogId}`, {
            id: finalCatalogId, language, name, setId: (setId ?? (await ctx.resolver.byId(language, finalCatalogId))?.setId) as string, setName, localId: (localId ?? (await ctx.resolver.byId(language, finalCatalogId))?.localId) as string,
            rarity, imageUrl
          });
        }
      } else if (customId !== null) {
        finalCustomId = customId;
      } else if (setId !== null && localId !== null) {
        const hits = await ctx.resolver.byTriple(language, setId, localId);
        if (hits.length > 1) err('AMBIGUOUS_CARD', 'More than one cached card matches set_id + local_id', ['local_id']);
        else if (hits.length === 1) {
          finalCatalogId = hits[0] as string;
          const key = `${language}\u0000${finalCatalogId}`;
          if (!refs.has(key) && name) refs.set(key, { id: finalCatalogId, language, name, setId, setName, localId, rarity, imageUrl });
        }
      }
      if (finalCatalogId === null && finalCustomId === null && issues.length === before && name) {
        const tuple = JSON.stringify([language, name, setId, setName, localId, rarity, imageUrl]);
        let generated = implicitCustoms.get(tuple);
        if (!generated) {
          generated = ctx.uuid();
          implicitCustoms.set(tuple, generated);
          customDefs.set(generated, { id: generated, name, setId, setName, localId, language, rarity, imageUrl, notes: null, createdAt: ctx.now, updatedAt: ctx.now });
          issue(warnings, 'customCards', rowNo, generated, 'CUSTOM_CARD_CREATED', 'No catalog match: a custom card was created for this row');
        }
        finalCustomId = generated;
      }
      if (finalCustomId !== null && customId !== null && name) {
        const def: Doc['customCards'][number] = {
          id: customId, name, setId, setName, localId, language, rarity, imageUrl, notes: cell('custom_card_notes'),
          createdAt: cell('custom_card_created_at') ?? ctx.now, updatedAt: cell('custom_card_updated_at') ?? cell('custom_card_created_at') ?? ctx.now
        };
        const prior = customDefs.get(customId);
        if (prior && !sameJson(prior, def)) issue(issues, 'customCards', rowNo, customId, 'CONFLICTING_PARENT', 'The same custom_card_id has different definitions in the file', ['custom_card_id']);
        else customDefs.set(customId, def);
      }
    }

    // --- acquisition
    let acquisitionId = cell('acquisition_id');
    if (acquisitionId !== null && !Id.safeParse(acquisitionId).success) { issue(issues, 'acquisitions', rowNo, acquisitionId, 'INVALID_ID', 'acquisition_id is not a valid UUID', ['acquisition_id']); acquisitionId = null; }
    const purchaseDate = cell('purchase_date');
    if (purchaseDate !== null && !DateOnly.safeParse(purchaseDate).success) issue(issues, 'acquisitions', rowNo, acquisitionId, 'INVALID_DATE', 'purchase_date must be a real YYYY-MM-DD date', ['purchase_date']);
    const acqFields = { purchasedOn: purchaseDate, source: cell('purchase_source'), notes: cell('acquisition_notes') };
    const hasAcqFields = acqFields.purchasedOn !== null || acqFields.source !== null || acqFields.notes !== null;
    if (acquisitionId !== null && hasAcqFields) {
      const def = { id: acquisitionId, ...acqFields, createdAt: ctx.now, updatedAt: ctx.now };
      const prior = acqDefs.get(acquisitionId);
      if (prior && !sameJson(prior, def)) issue(issues, 'acquisitions', rowNo, acquisitionId, 'CONFLICTING_PARENT', 'The same acquisition_id has different values in the file', ['acquisition_id']);
      else acqDefs.set(acquisitionId, def);
    } else if (acquisitionId === null && hasAcqFields) {
      acquisitionId = ctx.uuid(); // distinct event per row; never deduplicated by coincidence
      acqDefs.set(acquisitionId, { id: acquisitionId, ...acqFields, createdAt: ctx.now, updatedAt: ctx.now });
    }

    // --- storage location
    let locationId = cell('storage_location_id');
    if (locationId !== null && !Id.safeParse(locationId).success) { issue(issues, 'storageLocations', rowNo, locationId, 'INVALID_ID', 'storage_location_id is not a valid UUID', ['storage_location_id']); locationId = null; }
    const locName = cell('storage_location_name');
    const locDescription = cell('storage_location_description');
    if (locationId !== null && locName !== null) {
      const def = { id: locationId, name: locName, description: locDescription, createdAt: ctx.now, updatedAt: ctx.now };
      const prior = locDefs.get(locationId);
      if (prior && !sameJson(prior, def)) issue(issues, 'storageLocations', rowNo, locationId, 'CONFLICTING_PARENT', 'The same storage_location_id has different values in the file', ['storage_location_id']);
      else locDefs.set(locationId, def);
    } else if (locationId === null && locName !== null) {
      const key = nameKeyOf(locName);
      locationId = locByName.get(key) ?? (await ctx.resolver.locationByName(key)) ?? null;
      if (!locationId) {
        locationId = ctx.uuid();
        locDefs.set(locationId, { id: locationId, name: locName, description: locDescription, createdAt: ctx.now, updatedAt: ctx.now });
      }
      locByName.set(key, locationId);
    }

    // --- groups (parallel JSON arrays)
    const parseArray = (column: CsvColumn): unknown[] | null => {
      const raw = cell(column);
      if (raw === null) return [];
      try {
        const value = JSON.parse(raw) as unknown;
        if (Array.isArray(value)) return value;
      } catch { /* fallthrough */ }
      issue(issues, 'collectionGroups', rowNo, null, 'INVALID_JSON_ARRAY', `${column} must be a JSON array`, [column]);
      return null;
    };
    const gIds = parseArray('group_ids');
    const gNames = parseArray('group_names');
    const gDescriptions = parseArray('group_descriptions');
    const groupIds: string[] = [];
    if (gIds && gNames && gDescriptions) {
      const count = Math.max(gIds.length, gNames.length);
      if ((gNames.length > 0 && gNames.length !== gIds.length && gIds.length > 0) || (gDescriptions.length > 0 && gDescriptions.length !== gNames.length)) {
        issue(issues, 'collectionGroups', rowNo, null, 'ARRAY_LENGTH', 'group_ids, group_names and group_descriptions must be parallel', ['group_ids']);
      } else {
        for (let i = 0; i < count; i += 1) {
          let gid = gIds[i] === undefined ? null : String(gIds[i]);
          const gname = gNames[i] === undefined ? null : String(gNames[i]);
          const gdesc = gDescriptions[i] === undefined || gDescriptions[i] === null ? null : String(gDescriptions[i]);
          if (gid !== null && !Id.safeParse(gid).success) { issue(issues, 'collectionGroups', rowNo, gid, 'INVALID_ID', 'group id is not a valid UUID', ['group_ids', i]); continue; }
          if (gid !== null && gname !== null) {
            const def = { id: gid, name: gname, description: gdesc, createdAt: ctx.now, updatedAt: ctx.now };
            const prior = groupDefs.get(gid);
            if (prior && !sameJson(prior, def)) issue(issues, 'collectionGroups', rowNo, gid, 'CONFLICTING_PARENT', 'The same group id has different values in the file', ['group_ids', i]);
            else groupDefs.set(gid, def);
          } else if (gid === null && gname !== null) {
            const key = nameKeyOf(gname);
            gid = groupByName.get(key) ?? (await ctx.resolver.groupByName(key)) ?? null;
            if (!gid) {
              gid = ctx.uuid();
              groupDefs.set(gid, { id: gid, name: gname, description: gdesc, createdAt: ctx.now, updatedAt: ctx.now });
            }
            groupByName.set(key, gid);
          }
          if (gid !== null && !groupIds.includes(gid)) groupIds.push(gid);
        }
      }
    }

    // --- grade
    const company = cell('grading_company');
    const gradeValue = cell('grade');
    const gradeCert = cell('cert_number');
    const gradeNotes = cell('grade_notes');
    const gradeLabel = cell('grading_company_label');
    const isGradedCell = cell('is_graded');
    let graded = false;
    const anyGradeField = company !== null || gradeValue !== null || gradeCert !== null || gradeNotes !== null || gradeLabel !== null || cell('grade_id') !== null;
    if (isGradedCell !== null && isGradedCell !== 'true' && isGradedCell !== 'false') issue(issues, 'grades', rowNo, null, 'INVALID_BOOLEAN', 'is_graded must be true or false', ['is_graded']);
    else if (isGradedCell === 'false') {
      if (anyGradeField) issue(issues, 'grades', rowNo, null, 'GRADE_CONFLICT', 'is_graded is false but grade fields are present', ['is_graded']);
    } else if (isGradedCell === 'true') graded = true;
    else graded = company !== null && gradeValue !== null;
    let gradeRow: Doc['grades'][number] | null = null;
    if (graded) {
      const gid = cell('grade_id');
      const companyParsed = parseOr(Company, company ?? '');
      if (!companyParsed || !gradeValue) issue(issues, 'grades', rowNo, gid, 'INVALID_GRADE', 'A graded copy needs a valid grading_company and grade', ['grading_company']);
      else if (gid !== null && !Id.safeParse(gid).success) issue(issues, 'grades', rowNo, gid, 'INVALID_ID', 'grade_id is not a valid UUID', ['grade_id']);
      else if (gid !== null && gradeIds.has(gid)) issue(issues, 'grades', rowNo, gid, 'DUPLICATE_ID', 'grade_id is used by more than one copy', ['grade_id']);
      else {
        const finalGradeId = gid ?? ctx.uuid();
        gradeIds.add(finalGradeId);
        gradeRow = { id: finalGradeId, ownedCardId: id, company: companyParsed, companyLabel: gradeLabel, grade: gradeValue, certNumber: gradeCert, notes: gradeNotes, createdAt: ctx.now, updatedAt: ctx.now };
      }
    }

    // --- scan session
    let sessionId = cell('scan_session_id');
    if (sessionId !== null && !Id.safeParse(sessionId).success) { issue(issues, 'scanSessions', rowNo, sessionId, 'INVALID_ID', 'scan_session_id is not a valid UUID', ['scan_session_id']); sessionId = null; }
    if (sessionId !== null && cell('scan_session_status') !== null) {
      const status = cell('scan_session_status');
      const startedAt = cell('scan_session_started_at');
      if (!status || !['open', 'closed', 'abandoned'].includes(status) || !startedAt) issue(issues, 'scanSessions', rowNo, sessionId, 'INVALID_SESSION', 'scan session status/start are invalid', ['scan_session_status']);
      else {
        const def = { id: sessionId, status: status as 'open', startedAt, endedAt: cell('scan_session_ended_at'), notes: cell('scan_session_notes') };
        const prior = sessionDefs.get(sessionId);
        if (prior && !sameJson(prior, def)) issue(issues, 'scanSessions', rowNo, sessionId, 'CONFLICTING_PARENT', 'The same scan_session_id has different values in the file', ['scan_session_id']);
        else sessionDefs.set(sessionId, def);
      }
    }

    // --- money / enums / timestamps
    const cents = (column: CsvColumn): number | null => {
      const raw = cell(column);
      if (raw === null) return null;
      if (!/^\d+$/.test(raw)) { issue(issues, 'ownedCards', rowNo, id, 'INVALID_MONEY', `${column} must be a non-negative integer number of cents`, [column]); return null; }
      return Number(raw);
    };
    const currency = (column: CsvColumn): 'USD' | 'EUR' | null => {
      const raw = cell(column);
      if (raw === null) return null;
      const parsed = parseOr(Currency, raw);
      if (!parsed) issue(issues, 'ownedCards', rowNo, id, 'INVALID_ENUM', `${column} must be USD or EUR`, [column]);
      return parsed ?? null;
    };
    const purchaseCents = cents('purchase_price_cents');
    const purchaseCurrency = currency('purchase_currency');
    const manualCents = cents('manual_price_cents');
    const manualCurrency = currency('manual_price_currency');
    const conditionRaw = cell('condition');
    const condition = conditionRaw === null ? null : (parseOr(Condition, conditionRaw) ?? null);
    if (conditionRaw !== null && condition === null) issue(issues, 'ownedCards', rowNo, id, 'INVALID_ENUM', 'condition must be NM, LP, MP, HP, DMG or blank', ['condition']);
    const createdAt = cell('created_at') ?? ctx.now;
    const updatedAt = cell('updated_at') ?? cell('created_at') ?? ctx.now;
    for (const [column, value] of [['created_at', createdAt], ['updated_at', updatedAt]] as const) {
      if (!Instant.safeParse(value).success) issue(issues, 'ownedCards', rowNo, id, 'INVALID_TIMESTAMP', `${column} must be a canonical UTC timestamp`, [column]);
    }

    if (issues.length === before && language && variant && name) {
      doc.ownedCards.push({
        id, catalogCardId: finalCatalogId, customCardId: finalCustomId, name, setId, setName, localId, language, rarity, imageUrl, variant, variantDetail: cell('variant_detail') ?? '',
        condition, acquisitionId, purchasePriceCents: purchaseCents, purchaseCurrency, storageLocationId: locationId, scanSessionId: sessionId, notes: cell('notes'),
        manualPriceCents: manualCents, manualPriceCurrency: manualCurrency, createdAt, updatedAt
      });
      if (gradeRow) doc.grades.push(gradeRow);
      for (const gid of groupIds) doc.collectionGroupMembers.push({ collectionGroupId: gid, ownedCardId: id });
    }
  }

  doc.catalogRefs = [...refs.values()];
  doc.customCards = [...customDefs.values()];
  doc.acquisitions = [...acqDefs.values()];
  doc.storageLocations = [...locDefs.values()];
  doc.collectionGroups = [...groupDefs.values()];
  doc.scanSessions = [...sessionDefs.values()];
  const idIndex = header.indexOf('owned_card_id');
  if (table.slice(1).some((l) => idIndex < 0 || (l[idIndex] ?? '') === '')) {
    warnings.push({ entity: 'ownedCards', row: null, id: null, code: 'NO_STABLE_IDS', message: 'Rows without owned_card_id become NEW physical copies: importing the same file twice adds duplicates.', path: [] });
  }
  return { doc, issues, warnings, read: table.length - 1 };
}
