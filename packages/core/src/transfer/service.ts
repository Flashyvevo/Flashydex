import {
  AcquisitionRow, ById, CatalogRefRow, CollectionGroupRow, CustomCardRow, EXPORT_ENTITIES, ExportInput, GradeRow, GroupMemberRow, ImportCommit, ImportCommitResult,
  ImportDryRun, ImportReport, OwnedCardRow, PriceSnapshotRow, ScanSessionRow, ShareInput, StorageLocationRow, type CollectionExportV1, type ExportEntityName,
  type FileRef, type ImportIssue, type Input
} from '@flashydex/schemas';
import type { z } from 'zod';
import { sha256Hex } from '../catalog/sha256';
import { chunk, placeholders, type Exec } from '../db/sql';
import { ImportError, NotFoundError, PreviewExpiredError, SizeLimitError, StalePreviewError, ConflictError } from '../errors';
import type { Platform } from '../platform/platform';
import { bumpRevision, nameKeyOf, parse, readRevision, type ServiceContext } from '../services/context';
import { nameSearch } from '../catalog/tcgdex';
import { buildCsv } from './csv-export';
import { csvToEntities, type CsvResolver } from './import-csv';
import { buildPlan, canonicalJson, ledgerKey, type Built, type DbState, type Plan } from './import-plan';
import { readPersonalSnapshot } from './snapshot';

type Doc = CollectionExportV1;
type ExportFile = { file: FileRef; format: 'json' | 'csv'; warnings: string[] };

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_COPIES = 100_000;
export const MAX_ENTITIES = 250_000;
const PREVIEW_MS = 30 * 60 * 1000;
const RECEIPT_MS = 24 * 60 * 60 * 1000;

const ROW_SCHEMAS: Record<ExportEntityName, z.ZodType> = {
  catalogRefs: CatalogRefRow, customCards: CustomCardRow, acquisitions: AcquisitionRow, storageLocations: StorageLocationRow, collectionGroups: CollectionGroupRow,
  scanSessions: ScanSessionRow, ownedCards: OwnedCardRow, grades: GradeRow, collectionGroupMembers: GroupMemberRow, priceSnapshots: PriceSnapshotRow
};

type Preview = {
  report: ImportReport;
  plan: Plan;
  built: Built;
  doc: Doc;
};

const compact = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const addMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

const sortKey = (entity: ExportEntityName, row: Record<string, unknown>): string => {
  if (entity === 'catalogRefs') return `${row.language}\u0000${row.id}`;
  if (entity === 'collectionGroupMembers') return `${row.collectionGroupId}\u0000${row.ownedCardId}`;
  return String(row.id);
};

export class TransferService {
  private readonly previews = new Map<string, Preview>();

  constructor(private readonly ctx: ServiceContext, private readonly platform: Platform, private readonly appVersion = '0.1.0') {}

  /* ------------------------------------------------------------------------------------------ export */
  /** Consistent personal snapshot -> JSON (CollectionExportV1) or CSV (45 columns) in the private exports area. */
  async exportFile(input: Input<typeof ExportInput>): Promise<ExportFile> {
    const { format } = parse(ExportInput, input);
    const now = this.ctx.env.clock.now();
    const doc = await this.ctx.databases.user.read((q) => readPersonalSnapshot(q, now, this.appVersion));
    let text: string;
    let warnings: string[] = [];
    if (format === 'json') text = JSON.stringify(doc);
    else {
      const built = buildCsv(doc);
      text = built.csv;
      warnings = built.warnings;
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_IMPORT_BYTES * 8) throw new SizeLimitError('The export is too large');
    const file = await this.platform.filesystem.write({
      name: `flashydex-${compact(now)}.${format}`, mime: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8', bytes, area: 'exports'
    });
    return { file, format, warnings };
  }

  shareExport(input: Input<typeof ShareInput>): Promise<{ outcome: 'shared' | 'downloaded' | 'cancelled' }> {
    const { files, title } = parse(ShareInput, input);
    return this.platform.share({ files, title });
  }

  /* ------------------------------------------------------------------------------------------ dry run */
  private async loadState(doc: Doc): Promise<DbState> {
    const user = this.ctx.databases.user;
    const current = await user.read((q) => readPersonalSnapshot(q, '1970-01-01T00:00:00.000Z', 'state'));
    const ledger = new Set<string>();
    const priceById = new Map<string, Doc['priceSnapshots'][number]>();
    const priceByKey = new Map<string, string>();
    await user.read(async (q) => {
      const wantIdentities = new Map<string, string[]>();
      for (const r of doc.catalogRefs) wantIdentities.set(r.language, [...(wantIdentities.get(r.language) ?? []), r.id]);
      for (const p of doc.priceSnapshots) wantIdentities.set(p.language, [...(wantIdentities.get(p.language) ?? []), p.catalogCardId]);
      for (const [language, ids] of wantIdentities) {
        for (const part of chunk([...new Set(ids)], 100)) {
          for (const row of await q.rows(`SELECT id FROM catalog_identities WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part])) ledger.add(ledgerKey(language, String(row[0])));
        }
      }
      for (const part of chunk(doc.priceSnapshots.map((p) => p.id), 100)) {
        for (const row of await q.select<Doc['priceSnapshots'][number]>(PRICE_COLS, `FROM price_snapshots WHERE id IN (${placeholders(part.length)})`, part)) priceById.set(row.id, row);
      }
      for (const part of chunk(doc.priceSnapshots.map((p) => p.observationKey), 100)) {
        for (const row of await q.rows(`SELECT observation_key, id FROM price_snapshots WHERE observation_key IN (${placeholders(part.length)})`, part)) priceByKey.set(String(row[0]), String(row[1]));
      }
    });
    // Cached catalog identities (for CATALOG_METADATA_MISSING warnings only).
    const cached = new Set<string>();
    const byLanguage = new Map<'en' | 'ja', string[]>();
    for (const r of doc.catalogRefs) byLanguage.set(r.language, [...(byLanguage.get(r.language) ?? []), r.id]);
    for (const [language, ids] of byLanguage) {
      const catalog = await this.ctx.databases.catalog(language);
      if (!catalog) continue;
      for (const part of chunk(ids, 100)) for (const row of await catalog.rows(`SELECT id FROM catalog_cards WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part])) cached.add(ledgerKey(language, String(row[0])));
    }
    return { doc: current, ledger, priceById, priceByKey, catalogCached: (language, id) => cached.has(ledgerKey(language, id)) };
  }

  private resolver(): CsvResolver {
    const user = this.ctx.databases.user;
    return {
      byId: async (language, id) => {
        const db = await this.ctx.databases.catalog(language);
        const row = db ? (await db.rows('SELECT set_id, local_id FROM catalog_cards WHERE language = ? AND id = ?', [language, id]))[0] : undefined;
        return row ? { setId: String(row[0]), localId: String(row[1]) } : null;
      },
      byTriple: async (language, setId, localId) => {
        const db = await this.ctx.databases.catalog(language);
        return db ? (await db.rows('SELECT id FROM catalog_cards WHERE language = ? AND set_id = ? AND local_id = ?', [language, setId, localId])).map((r) => String(r[0])) : [];
      },
      locationByName: async (key) => ((await user.rows('SELECT id FROM storage_locations WHERE name_key = ?', [key]))[0]?.[0] as string | undefined) ?? null,
      groupByName: async (key) => ((await user.rows('SELECT id FROM collection_groups WHERE name_key = ?', [key]))[0]?.[0] as string | undefined) ?? null
    };
  }

  /** Zero DB writes: parse, validate, resolve, plan, hash. The plan lives in memory (30 min) and nowhere else. */
  async dryRun(input: Input<typeof ImportDryRun>): Promise<ImportReport> {
    const { format, conflictPolicy, file } = parse(ImportDryRun, input);
    if (file.size > MAX_IMPORT_BYTES) throw new SizeLimitError('The file is larger than 25 MiB', { maxBytes: MAX_IMPORT_BYTES });
    const bytes = await this.platform.filesystem.read({ file, maxBytes: MAX_IMPORT_BYTES });
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new SizeLimitError('The file is larger than 25 MiB', { maxBytes: MAX_IMPORT_BYTES });
    const createdAt = this.ctx.env.clock.now();
    const inputHash = await this.platform.hash.sha256(bytes);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ImportError(format === 'json' ? 'INVALID_JSON' : 'INVALID_CSV', 'The file is not valid UTF-8');
    }

    let doc: Doc;
    let pre: ImportIssue[] = [];
    let preWarnings: ImportIssue[] = [];
    const invalid: Partial<Record<ExportEntityName, number>> = {};
    const rowMap: Partial<Record<ExportEntityName, number[]>> = {};
    if (format === 'json') {
      const parsed = this.parseJson(text);
      doc = parsed.doc;
      pre = parsed.issues;
      Object.assign(invalid, parsed.invalid);
      Object.assign(rowMap, parsed.rowMap);
    } else {
      const outcome = await csvToEntities(text, { now: createdAt, uuid: () => this.ctx.env.ids.uuid(), resolver: this.resolver() });
      doc = outcome.doc;
      pre = outcome.issues;
      preWarnings = outcome.warnings;
      invalid.ownedCards = new Set(outcome.issues.filter((i) => i.entity === 'ownedCards' || i.row !== null).map((i) => i.row)).size;
    }
    const total = EXPORT_ENTITIES.reduce((n, e) => n + doc[e].length, 0);
    if (doc.ownedCards.length > MAX_COPIES || total > MAX_ENTITIES) throw new SizeLimitError('The file has too many rows', { maxCopies: MAX_COPIES, maxEntities: MAX_ENTITIES });

    const state = await this.loadState(doc);
    const revision = await this.ctx.databases.user.read((q) => readRevision(q));
    const built = buildPlan(doc, conflictPolicy, state, invalid, rowMap, pre, preWarnings);
    const rows = this.sortedRows(built.plan);
    const id = this.ctx.env.ids.uuid();
    const planHash = sha256Hex(canonicalJson({ schemaVersion: 1, inputHash, conflictPolicy, collectionRevision: revision, createdAt, rows }));
    const changes: ImportReport['changes'] = [];
    let seen = 0;
    for (const entity of EXPORT_ENTITIES) {
      for (const r of rows.entities[entity]) {
        seen += 1;
        if (changes.length < 100) changes.push({ entity, id: sortKey(entity, r.row as Record<string, unknown>), action: r.action, changedFields: r.changedFields });
      }
    }
    const report: ImportReport = {
      id, status: 'preview', format, conflictPolicy, valid: built.errorCount === 0, inputHash, planHash, createdAt, expiresAt: addMs(createdAt, PREVIEW_MS),
      collectionRevision: revision, counts: built.counts, errors: built.errors, warnings: built.warnings, errorCount: built.errorCount, warningCount: built.warningCount,
      changes, changesTruncated: seen > changes.length, result: null
    };
    this.previews.set(id, { report, plan: rows, built, doc });
    this.evict(createdAt);
    return report;
  }

  private evict(now: string): void {
    for (const [id, p] of this.previews) if (p.report.status === 'preview' && p.report.expiresAt < now) this.previews.delete(id);
  }

  private sortedRows(plan: Plan): Plan {
    const entities = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, [...plan.entities[e]].sort((a, b) => (sortKey(e, a.row as Record<string, unknown>) < sortKey(e, b.row as Record<string, unknown>) ? -1 : 1))])) as Plan['entities'];
    return {
      entities,
      removals: {
        grades: [...plan.removals.grades].sort(),
        members: [...plan.removals.members].sort((a, b) => (`${a.collectionGroupId}${a.ownedCardId}` < `${b.collectionGroupId}${b.ownedCardId}` ? -1 : 1))
      }
    };
  }

  private parseJson(text: string): { doc: Doc; issues: ImportIssue[]; invalid: Partial<Record<ExportEntityName, number>>; rowMap: Partial<Record<ExportEntityName, number[]>> } {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ImportError('INVALID_JSON', 'The file is not valid JSON');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ImportError('INVALID_JSON', 'The JSON root must be an object');
    const root = raw as Record<string, unknown>;
    if (root.schemaVersion !== 1) throw new ImportError('IMPORT_INVALID', 'Unsupported schemaVersion; only version 1 can be imported');
    const allowed = new Set<string>(['schemaVersion', 'exportedAt', 'appVersion', ...EXPORT_ENTITIES]);
    for (const key of Object.keys(root)) if (!allowed.has(key)) throw new ImportError('IMPORT_INVALID', `Unknown top-level key: ${key}`);
    for (const entity of EXPORT_ENTITIES) if (!Array.isArray(root[entity])) throw new ImportError('IMPORT_INVALID', `${entity} must be an array`);
    if (typeof root.exportedAt !== 'string' || typeof root.appVersion !== 'string') throw new ImportError('IMPORT_INVALID', 'exportedAt and appVersion are required');
    const total = EXPORT_ENTITIES.reduce((n, e) => n + (root[e] as unknown[]).length, 0);
    if ((root.ownedCards as unknown[]).length > MAX_COPIES || total > MAX_ENTITIES) throw new SizeLimitError('The file has too many rows', { maxCopies: MAX_COPIES, maxEntities: MAX_ENTITIES });

    const issues: ImportIssue[] = [];
    const invalid: Partial<Record<ExportEntityName, number>> = {};
    const rowMap: Partial<Record<ExportEntityName, number[]>> = {};
    const doc = { schemaVersion: 1, exportedAt: root.exportedAt, appVersion: root.appVersion } as Doc;
    for (const entity of EXPORT_ENTITIES) {
      const kept: unknown[] = [];
      const map: number[] = [];
      (root[entity] as unknown[]).forEach((row, index) => {
        let result: ReturnType<(typeof ROW_SCHEMAS)[ExportEntityName]['safeParse']>;
        try {
          result = ROW_SCHEMAS[entity].safeParse(row);
        } catch {
          // A validator that throws (instead of reporting an issue) must still yield a per-row report, never a failed dry run.
          result = { success: false, error: { issues: [{ code: 'custom', message: 'The row could not be validated', path: [] }] } } as unknown as typeof result;
        }
        if (result.success) { kept.push(result.data); map.push(index); return; }
        invalid[entity] = (invalid[entity] ?? 0) + 1;
        const id = row && typeof row === 'object' && 'id' in row ? String((row as { id: unknown }).id) : null;
        for (const i of result.error.issues) issues.push({ entity, row: index + 1, id, code: i.code, message: i.message, path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)) });
      });
      (doc as Record<string, unknown>)[entity] = kept;
      rowMap[entity] = map;
    }
    return { doc, issues, invalid, rowMap };
  }

  async getImport(input: Input<typeof ById>): Promise<ImportReport> {
    const { id } = parse(ById, input);
    const preview = this.previews.get(id);
    if (!preview) throw new NotFoundError('Import', id);
    if (preview.report.status === 'preview' && preview.report.expiresAt < this.ctx.env.clock.now()) throw new PreviewExpiredError();
    return preview.report;
  }

  /* ------------------------------------------------------------------------------------------ commit */
  async commit(input: Input<typeof ImportCommit>): Promise<ImportCommitResult> {
    const { id, planHash } = parse(ImportCommit, input);
    const user = this.ctx.databases.user;
    const now = this.ctx.env.clock.now();

    // 0. Stage E / N05: while persistence is uncertain no receipt (in-memory or read back from the live handle) may be turned into a success.
    const latched = user.persistenceBlock();
    if (latched) throw latched;

    // 1. receipt FIRST: an exact replay returns the original result even after expiry or a changed revision.
    // E01: lookup + latch check run under one serialized hold, so a flush that fails while we wait in the queue is seen.
    const receipt = (await user.durableRead((q) => q.rows('SELECT plan_hash, result_json, expires_at FROM data_operation_receipts WHERE id = ?', [id])))[0];
    if (receipt && String(receipt[2]) > now) {
      if (String(receipt[0]) !== planHash) throw new ConflictError('This import id was already committed with a different plan');
      return ImportCommitResult.parse(JSON.parse(String(receipt[1])));
    }

    const preview = this.previews.get(id);
    if (!preview) throw new NotFoundError('Import', id);
    if (preview.report.status === 'committed' && preview.report.result) {
      if (preview.report.planHash !== planHash) throw new ConflictError('This import id was already committed with a different plan');
      const stillBlocked = user.persistenceBlock(); // in-memory result: only valid while storage is not latched
      if (stillBlocked) throw stillBlocked;
      return preview.report.result;
    }
    if (preview.report.expiresAt < now) throw new PreviewExpiredError();
    if (preview.report.planHash !== planHash) throw new ImportError('IMPORT_INVALID', 'The plan hash does not match this preview');
    const recomputed = sha256Hex(canonicalJson({
      schemaVersion: 1, inputHash: preview.report.inputHash, conflictPolicy: preview.report.conflictPolicy, collectionRevision: preview.report.collectionRevision,
      createdAt: preview.report.createdAt, rows: preview.plan
    }));
    if (recomputed !== planHash) throw new ImportError('IMPORT_INVALID', 'The staged plan was modified');
    if (!preview.report.valid) throw new ImportError('IMPORT_INVALID', 'This plan has errors and cannot be committed');

    // 2. one transaction: revision check, writes, receipt, revision +1
    const result = await user.transaction(async (tx) => {
      const revision = await readRevision(tx);
      if (revision !== preview.report.collectionRevision) throw new StalePreviewError(preview.report.collectionRevision, revision);
      await tx.run('DELETE FROM data_operation_receipts WHERE expires_at <= ?', [now]);
      await this.apply(tx, preview.plan);
      await bumpRevision(tx, now);
      const counts = preview.report.counts;
      const total = Number((await tx.scalar<number>('SELECT COUNT(*) FROM owned_cards')) ?? 0);
      const committed: ImportCommitResult = {
        id, committedAt: now, collectionRevision: revision + 1, createdCopies: counts.ownedCards.create, updatedCopies: counts.ownedCards.update,
        skippedCopies: counts.ownedCards.skip, totalCards: total, counts
      };
      await tx.run('INSERT INTO data_operation_receipts (id, operation, plan_hash, result_json, committed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id, 'import', planHash, JSON.stringify(committed), now, addMs(now, RECEIPT_MS)
      ]);
      return committed;
    });
    preview.report = { ...preview.report, status: 'committed', result };
    return result;
  }

  private async apply(tx: Exec, plan: Plan): Promise<void> {
    const e = plan.entities;
    const active = <T>(rows: Array<{ action: string; row: T }>) => rows.filter((r) => r.action !== 'skip');
    for (const { action, row: r } of active(e.customCards)) {
      if (action === 'create') {
        await tx.run('INSERT INTO custom_cards (id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.id, r.name, nameSearch(r.name), r.setId, r.setName, r.localId, r.language, r.rarity, r.imageUrl, r.notes, r.createdAt, r.updatedAt]);
      } else {
        await tx.run('UPDATE custom_cards SET name = ?, name_search = ?, set_id = ?, set_name = ?, local_id = ?, language = ?, rarity = ?, image_url = ?, notes = ?, created_at = ?, updated_at = ? WHERE id = ?', [r.name, nameSearch(r.name), r.setId, r.setName, r.localId, r.language, r.rarity, r.imageUrl, r.notes, r.createdAt, r.updatedAt, r.id]);
      }
    }
    for (const { action, row: r } of active(e.acquisitions)) {
      if (action === 'create') await tx.run('INSERT INTO acquisitions (id, purchased_on, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [r.id, r.purchasedOn, r.source, r.notes, r.createdAt, r.updatedAt]);
      else await tx.run('UPDATE acquisitions SET purchased_on = ?, source = ?, notes = ?, created_at = ?, updated_at = ? WHERE id = ?', [r.purchasedOn, r.source, r.notes, r.createdAt, r.updatedAt, r.id]);
    }
    for (const [table, rows] of [['storage_locations', e.storageLocations], ['collection_groups', e.collectionGroups]] as const) {
      for (const { action, row: r } of active(rows)) {
        if (action === 'create') await tx.run(`INSERT INTO ${table} (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [r.id, r.name, nameKeyOf(r.name), r.description, r.createdAt, r.updatedAt]);
        else await tx.run(`UPDATE ${table} SET name = ?, name_key = ?, description = ?, created_at = ?, updated_at = ? WHERE id = ?`, [r.name, nameKeyOf(r.name), r.description, r.createdAt, r.updatedAt, r.id]);
      }
    }
    for (const { action, row: r } of active(e.scanSessions)) {
      if (action === 'create') await tx.run('INSERT INTO scan_sessions (id, status, started_at, ended_at, notes) VALUES (?, ?, ?, ?, ?)', [r.id, r.status, r.startedAt, r.endedAt, r.notes]);
      else await tx.run('UPDATE scan_sessions SET status = ?, started_at = ?, ended_at = ?, notes = ? WHERE id = ?', [r.status, r.startedAt, r.endedAt, r.notes, r.id]);
    }
    // identity ledger: stubs only, never invented catalog metadata
    for (const { row: r } of active(e.catalogRefs)) await tx.run('INSERT OR IGNORE INTO catalog_identities (language, id, created_at) VALUES (?, ?, ?)', [r.language, r.id, this.ctx.env.clock.now()]);
    for (const { action, row: c } of active(e.ownedCards)) {
      const values = [c.catalogCardId, c.customCardId, c.name, nameSearch(c.name), c.setId, c.setName, c.localId, c.language, c.rarity, c.imageUrl, c.variant, c.variantDetail, c.condition, c.acquisitionId, c.purchasePriceCents, c.purchaseCurrency, c.storageLocationId, c.scanSessionId, c.notes, c.manualPriceCents, c.manualPriceCurrency, c.createdAt, c.updatedAt];
      if (action === 'create') {
        await tx.run(`INSERT INTO owned_cards (catalog_card_id, custom_card_id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, variant, variant_detail, condition, acquisition_id, purchase_price_cents, purchase_currency, storage_location_id, scan_session_id, notes, manual_price_cents, manual_price_currency, created_at, updated_at, id) VALUES (${placeholders(24)})`, [...values, c.id]);
      } else {
        await tx.run('UPDATE owned_cards SET catalog_card_id = ?, custom_card_id = ?, name = ?, name_search = ?, set_id = ?, set_name = ?, local_id = ?, language = ?, rarity = ?, image_url = ?, variant = ?, variant_detail = ?, condition = ?, acquisition_id = ?, purchase_price_cents = ?, purchase_currency = ?, storage_location_id = ?, scan_session_id = ?, notes = ?, manual_price_cents = ?, manual_price_currency = ?, created_at = ?, updated_at = ? WHERE id = ?', [...values, c.id]);
      }
    }
    for (const gradeId of plan.removals.grades) await tx.run('DELETE FROM grades WHERE id = ?', [gradeId]);
    for (const m of plan.removals.members) await tx.run('DELETE FROM collection_group_members WHERE collection_group_id = ? AND owned_card_id = ?', [m.collectionGroupId, m.ownedCardId]);
    for (const { action, row: g } of active(e.grades)) {
      if (action === 'create') await tx.run('INSERT INTO grades (id, owned_card_id, company, company_label, grade, cert_number, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [g.id, g.ownedCardId, g.company, g.companyLabel, g.grade, g.certNumber, g.notes, g.createdAt, g.updatedAt]);
      else await tx.run('UPDATE grades SET owned_card_id = ?, company = ?, company_label = ?, grade = ?, cert_number = ?, notes = ?, created_at = ?, updated_at = ? WHERE id = ?', [g.ownedCardId, g.company, g.companyLabel, g.grade, g.certNumber, g.notes, g.createdAt, g.updatedAt, g.id]);
    }
    for (const { row: m } of active(e.collectionGroupMembers)) await tx.run('INSERT OR IGNORE INTO collection_group_members (collection_group_id, owned_card_id) VALUES (?, ?)', [m.collectionGroupId, m.ownedCardId]);
    for (const { row: p } of active(e.priceSnapshots)) {
      await tx.run(
        'INSERT OR IGNORE INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [p.id, p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents, p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey]
      );
    }
  }
}

const PRICE_COLS = {
  id: 'id', catalogCardId: 'catalog_card_id', language: 'language', source: 'source', variant: 'variant', variantDetail: 'variant_detail', providerVariantKey: 'provider_variant_key',
  currency: 'currency', lowCents: 'low_cents', midCents: 'mid_cents', highCents: 'high_cents', marketCents: 'market_cents', trendCents: 'trend_cents',
  sourceUpdatedAt: 'source_updated_at', capturedAt: 'captured_at', observationKey: 'observation_key'
} as const;
