import {
  BackupCreate, RestoreCommit, RestoreDryRun, type BackupCapabilities, type BackupPreview, type BackupProgress, type BackupProgressCallback, type BackupResult,
  type Empty, type FdxCounts, type FileRef, type Input, type RestoreResult
} from '@flashydex/schemas';
import { nameSearch } from '../catalog/tcgdex';
import { chunk, placeholders, type Exec } from '../db/sql';
import { BackupError, CancelledError, NotFoundError, PersistenceError, PreviewExpiredError, StalePreviewError, UnsupportedCapabilityError } from '../errors';
import type { Platform } from '../platform/platform';
import { bumpRevision, nameKeyOf, parse, type ServiceContext } from '../services/context';
import { canonicalJson } from '../transfer/import-plan';
import {
  buildArchive, countsOf, entitiesEqual, parseArchive, totalRows, DEFAULT_LIMITS, type Entities, type FdxLimits, type ParsedBackup, type Settings
} from './archive';
import { readFullSnapshot, readUserState } from './snapshot';
import type { FdxManifest } from './archive';

const FDX_MIME = 'application/vnd.flashydex.backup+zip';
const PREVIEW_MS = 10 * 60 * 1000;
const RECEIPT_MS = 24 * 60 * 60 * 1000;
const WARNING = 'Replaces all personal data' as const;

export type RestoreStage = 'afterDelete' | 'afterInsert';
export type BackupServiceOptions = {
  /** Lowered caps for tests; production passes nothing (docs/IMPORT-EXPORT.md hard limits). */
  limits?: Partial<FdxLimits>;
  /** Test seam: awaited inside the restore transaction; a throw proves the single-transaction rollback. */
  hooks?: { duringRestore?(stage: RestoreStage): void | Promise<void> };
};

type Staged = {
  id: string;
  parsed: ParsedBackup;
  backupHash: string;
  expiresAt: string;
  collectionRevision: number;
  userStateToken: string;
};

const compact = (iso: string): string => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const addMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

/** .fdx backup v1 (docs/IMPORT-EXPORT.md, D40/D41): ZIP create, zero-write preview, in-place single-transaction replacement restore. */
export class BackupService {
  private readonly previews = new Map<string, Staged>();
  private readonly consumed = new Set<string>();
  private readonly limits: FdxLimits;

  constructor(protected readonly ctx: ServiceContext, protected readonly platform: Platform, protected readonly appVersion = '0.0.0', protected readonly options: BackupServiceOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  }

  async capabilities(_input: Input<typeof Empty> = {}): Promise<BackupCapabilities> {
    const ok = Boolean(this.platform.filesystem);
    return { fdxCreate: ok, fdxRestore: ok, optionalCatalogPayload: false, reason: ok ? null : 'This device cannot read or write backup files' };
  }

  private emit(cb: BackupProgressCallback | undefined, p: BackupProgress): void {
    if (!cb) return;
    try { cb(p); } catch { /* observer errors are isolated */ }
  }

  private requireFilesystem(): void {
    if (!this.platform.filesystem) throw new UnsupportedCapabilityError('This device cannot read or write backup files');
  }

  private static cancelCheck(signal?: AbortSignal): void {
    if (signal?.aborted) throw new CancelledError();
  }

  /* ------------------------------------------------------------------------------------------ create */
  async create(input: Input<typeof BackupCreate>, onProgress?: BackupProgressCallback, signal?: AbortSignal): Promise<BackupResult> {
    const { includeUserImages, includeCatalogs } = parse(BackupCreate, input);
    if (includeCatalogs) throw new UnsupportedCapabilityError('Catalog payloads cannot be included in a backup yet');
    this.requireFilesystem();
    const warnings: string[] = [];
    if (includeUserImages) warnings.push('User images are not stored by this build, so none could be included in the backup.');
    const made = await this.produce(onProgress, signal);
    this.emit(onProgress, { phase: 'complete', bytesDone: made.bytes, bytesTotal: made.bytes, cancellable: false });
    return { file: made.file, format: 'fdx', backupVersion: 1, sha256: made.sha256, counts: made.counts, warnings };
  }

  /** Informational version hints for installed catalogs (receipts); no payloads. */
  private async catalogHints(): Promise<FdxManifest['catalogs']> {
    const rows = await this.ctx.databases.user.read((q) =>
      q.rows("SELECT language, version, schema_version, sha256 FROM installed_catalogs WHERE status = 'installed' AND version IS NOT NULL ORDER BY language ASC")
    );
    return rows.map((r) => ({
      language: r[0] as 'en' | 'ja', version: String(r[1]), schemaVersion: Number(r[2] ?? 1) || 1,
      baselineSha256: r[3] === null || r[3] === undefined ? null : String(r[3]), entryPath: null, rawSha256: null, uncompressedBytes: null
    }));
  }

  /** Snapshot -> archive -> write -> VERIFY (re-read, re-hash, parse through the restore parser, entities equal). */
  private async produce(onProgress?: BackupProgressCallback, signal?: AbortSignal): Promise<{ file: FileRef; sha256: string; counts: FdxCounts; bytes: number }> {
    this.emit(onProgress, { phase: 'snapshot', bytesDone: 0, bytesTotal: null, cancellable: true });
    const now = this.ctx.env.clock.now();
    const snap = await this.ctx.databases.user.read((q) => readFullSnapshot(q));
    BackupService.cancelCheck(signal);
    if (snap.entities.ownedCards.length > this.limits.ownedRows || totalRows(snap.entities) > this.limits.totalRows) throw new BackupError('SIZE_LIMIT', 'The collection is too large to back up');

    this.emit(onProgress, { phase: 'compressing', bytesDone: 0, bytesTotal: null, cancellable: true });
    const catalogs = await this.catalogHints();
    const built = await buildArchive({
      entities: snap.entities, settings: snap.settings, createdAt: now, appVersion: this.appVersion, backupId: this.ctx.env.ids.uuid(), hash: (b) => this.platform.hash.sha256(b), catalogs
    });
    if (built.bytes.byteLength > this.limits.archiveBytes) throw new BackupError('SIZE_LIMIT', 'The backup would be larger than the allowed size');
    BackupService.cancelCheck(signal);

    const sha256 = await this.platform.hash.sha256(built.bytes);
    const file = await this.platform.filesystem.write({ name: `flashydex-${compact(now)}.fdx`, mime: FDX_MIME, bytes: built.bytes, area: 'exports' });
    this.emit(onProgress, { phase: 'verifying', bytesDone: built.bytes.byteLength, bytesTotal: built.bytes.byteLength, cancellable: false });
    try {
      const back = await this.platform.filesystem.read({ file, maxBytes: this.limits.archiveBytes });
      if ((await this.platform.hash.sha256(back)) !== sha256) throw new BackupError('BACKUP_HASH_MISMATCH', 'The written backup does not match what was created');
      const parsed = await parseArchive(back, (b) => this.platform.hash.sha256(b), this.limits);
      if (!entitiesEqual(parsed.entities, snap.entities) || canonicalJson(parsed.settings) !== canonicalJson(snap.settings)) throw new BackupError('BACKUP_INVALID', 'The written backup does not match the collection');
    } catch (error) {
      await this.platform.filesystem.remove({ file }).catch(() => undefined);
      throw error;
    }
    return { file, sha256, counts: built.manifest.counts, bytes: built.bytes.byteLength };
  }

  /* ------------------------------------------------------------------------------------------ preview */
  private async stateToken(q: Exec): Promise<{ revision: number; token: string }> {
    const state = await readUserState(q);
    const token = await this.platform.hash.sha256(new TextEncoder().encode(canonicalJson(state)));
    return { revision: state.collectionRevision, token };
  }

  async previewRestore(input: Input<typeof RestoreDryRun>, onProgress?: BackupProgressCallback, signal?: AbortSignal): Promise<BackupPreview> {
    const { file } = parse(RestoreDryRun, input);
    this.requireFilesystem();
    if (file.size > this.limits.archiveBytes) throw new BackupError('SIZE_LIMIT', 'The backup file is too large');
    this.emit(onProgress, { phase: 'staging', bytesDone: 0, bytesTotal: file.size, cancellable: true });
    const bytes = await this.platform.filesystem.read({ file, maxBytes: this.limits.archiveBytes });
    if (bytes.byteLength > this.limits.archiveBytes) throw new BackupError('SIZE_LIMIT', 'The backup file is too large');
    BackupService.cancelCheck(signal);
    const backupHash = await this.platform.hash.sha256(bytes);
    const parsed = await parseArchive(bytes, (b) => this.platform.hash.sha256(b), this.limits);
    BackupService.cancelCheck(signal);
    this.emit(onProgress, { phase: 'verifying', bytesDone: bytes.byteLength, bytesTotal: bytes.byteLength, cancellable: true });

    const { revision, token } = await this.ctx.databases.user.read((q) => this.stateToken(q));
    const { matched, missing } = await this.resolveIdentities(parsed.entities);
    BackupService.cancelCheck(signal);

    const now = this.ctx.env.clock.now();
    const id = this.ctx.env.ids.uuid();
    const expiresAt = addMs(now, PREVIEW_MS);
    for (const [key, p] of this.previews) if (p.expiresAt < now) this.previews.delete(key);
    this.previews.set(id, { id, parsed, backupHash, expiresAt, collectionRevision: revision, userStateToken: token });

    const warnings: string[] = [];
    const images = parsed.entities.userImages;
    if (images.some((u) => !u.included)) warnings.push(`${images.filter((u) => !u.included).length} user image(s) were not included in this backup; they will show as missing.`);
    if (images.some((u) => u.included)) warnings.push('User image files in this backup are not restored by this build.');
    if (missing > 0) warnings.push(`${missing} card(s) are not in the installed catalog; their saved name, set and image are kept as they are.`);
    this.emit(onProgress, { phase: 'complete', bytesDone: bytes.byteLength, bytesTotal: bytes.byteLength, cancellable: false });
    return {
      id, backupHash, expiresAt, backupVersion: 1, counts: countsOf(parsed.entities), totalCards: parsed.entities.ownedCards.length, customCards: parsed.entities.customCards.length,
      collectionRevision: revision, userStateToken: token, matchedCatalogIdentities: matched, missingCatalogIdentities: missing, warnings, warning: WARNING
    };
  }

  /** Exact (language,id) lookups in 100-key batches; no catalog installed = everything missing (never an error). */
  private async resolveIdentities(e: Entities): Promise<{ matched: number; missing: number }> {
    const byLanguage = new Map<'en' | 'ja', string[]>();
    for (const r of e.catalogIdentities) byLanguage.set(r.language, [...(byLanguage.get(r.language) ?? []), r.id]);
    let matched = 0;
    for (const [language, ids] of byLanguage) {
      let catalog;
      try { catalog = await this.ctx.databases.catalog(language); } catch { catalog = null; }
      if (!catalog) continue;
      for (const part of chunk(ids, 100)) {
        const rows = await catalog.rows(`SELECT id FROM catalog_cards WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part]);
        matched += new Set(rows.map((r) => String(r[0]))).size;
      }
    }
    return { matched, missing: e.catalogIdentities.length - matched };
  }

  /* ------------------------------------------------------------------------------------------ restore */
  async restore(input: Input<typeof RestoreCommit>, onProgress?: BackupProgressCallback, signal?: AbortSignal): Promise<RestoreResult> {
    const { id, backupHash, userStateToken } = parse(RestoreCommit, input);
    this.requireFilesystem();
    const user = this.ctx.databases.user;

    const receipt = (await user.rows('SELECT id FROM restore_receipts WHERE id = ? AND expires_at > ?', [id, this.ctx.env.clock.now()]))[0];
    if (receipt || this.consumed.has(id)) throw new BackupError('ALREADY_RESTORED', 'This backup preview was already restored');
    const staged = this.previews.get(id);
    if (!staged) throw new NotFoundError('Restore preview', id);
    if (staged.expiresAt < this.ctx.env.clock.now()) { this.previews.delete(id); throw new PreviewExpiredError(); }
    if (backupHash !== staged.backupHash) throw new BackupError('BACKUP_HASH_MISMATCH', 'The backup hash does not match this preview');
    BackupService.cancelCheck(signal);

    const lease = await this.ctx.databases.coordinator.admit('restore', { token: this.ctx.env.ids.uuid(), now: this.ctx.env.clock.now() });
    let safety: FileRef | null = null;
    try {
      const current = await user.read((q) => this.stateToken(q));
      if (userStateToken !== staged.userStateToken || current.token !== staged.userStateToken || current.revision !== staged.collectionRevision) {
        throw new StalePreviewError(staged.collectionRevision, current.revision);
      }
      BackupService.cancelCheck(signal);

      const made = await this.produce(onProgress, signal); // safety backup of the CURRENT state, verified before anything is touched
      safety = made.file;
      BackupService.cancelCheck(signal);

      this.emit(onProgress, { phase: 'activating', bytesDone: 0, bytesTotal: null, cancellable: false });
      const now = this.ctx.env.clock.now();
      const e = staged.parsed.entities;
      let result: RestoreResult;
      try {
        result = await user.transaction(async (tx) => {
          const inside = await this.stateToken(tx);
          if (inside.token !== staged.userStateToken || inside.revision !== staged.collectionRevision) throw new StalePreviewError(staged.collectionRevision, inside.revision);
          await this.wipePersonal(tx);
          await this.options.hooks?.duringRestore?.('afterDelete');
          await this.insertArchive(tx, e, staged.parsed.settings);
          await this.options.hooks?.duringRestore?.('afterInsert');
          await bumpRevision(tx, now);
          const out: RestoreResult = { restored: true, totalCards: e.ownedCards.length, counts: countsOf(e), safetyBackup: made.file, restoredAt: now, restartRequired: false };
          await tx.run('DELETE FROM restore_receipts WHERE expires_at <= ?', [now]);
          await tx.run('INSERT INTO restore_receipts (id, backup_hash, result_json, restored_at, expires_at) VALUES (?, ?, ?, ?, ?)', [id, staged.backupHash, JSON.stringify(out), now, addMs(now, RECEIPT_MS)]);
          return out;
        });
      } catch (error) {
        // PERSISTENCE_FAILED means COMMIT happened: the preview is consumed and the safety backup must stay.
        if (error instanceof PersistenceError) { this.consume(id); safety = null; }
        throw error;
      }
      this.consume(id);
      safety = null;
      this.emit(onProgress, { phase: 'complete', bytesDone: 0, bytesTotal: null, cancellable: false });
      return result;
    } catch (error) {
      if (safety) await this.platform.filesystem.remove({ file: safety }).catch(() => undefined);
      throw error;
    } finally {
      await lease.release();
    }
  }

  private consume(id: string): void {
    this.consumed.add(id);
    this.previews.delete(id);
  }

  /** FK-safe order: dependents first. Operational tables are never touched. */
  private async wipePersonal(tx: Exec): Promise<void> {
    for (const table of ['collection_group_members', 'grades', 'owned_cards', 'collection_groups', 'storage_locations', 'acquisitions', 'scan_sessions', 'custom_cards', 'catalog_annotations', 'price_snapshots', 'catalog_identities']) {
      await tx.run(`DELETE FROM ${table}`);
    }
  }

  private async insertArchive(tx: Exec, e: Entities, s: Settings): Promise<void> {
    for (const r of e.catalogIdentities) await tx.run('INSERT INTO catalog_identities (language, id, created_at) VALUES (?, ?, ?)', [r.language, r.id, r.createdAt]);
    for (const r of e.catalogAnnotations) {
      await tx.run('INSERT INTO catalog_annotations (language, catalog_card_id, display_overrides_json, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [r.language, r.catalogCardId, JSON.stringify(r.displayOverrides), r.notes, r.createdAt, r.updatedAt]);
    }
    for (const p of e.priceSnapshots) {
      await tx.run(
        'INSERT INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [p.id, p.catalogCardId, p.language, p.source, p.variant, p.variantDetail, p.providerVariantKey, p.currency, p.lowCents, p.midCents, p.highCents, p.marketCents, p.trendCents, p.sourceUpdatedAt, p.capturedAt, p.observationKey]
      );
    }
    for (const r of e.customCards) {
      await tx.run('INSERT INTO custom_cards (id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [r.id, r.name, nameSearch(r.name), r.setId, r.setName, r.localId, r.language, r.rarity, r.imageUrl, r.notes, r.createdAt, r.updatedAt]);
    }
    for (const r of e.acquisitions) await tx.run('INSERT INTO acquisitions (id, purchased_on, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [r.id, r.purchasedOn, r.source, r.notes, r.createdAt, r.updatedAt]);
    for (const [table, rows] of [['storage_locations', e.storageLocations], ['collection_groups', e.collectionGroups]] as const) {
      for (const r of rows) await tx.run(`INSERT INTO ${table} (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [r.id, r.name, nameKeyOf(r.name), r.description, r.createdAt, r.updatedAt]);
    }
    for (const r of e.scanSessions) await tx.run('INSERT INTO scan_sessions (id, status, started_at, ended_at, notes) VALUES (?, ?, ?, ?, ?)', [r.id, r.status, r.startedAt, r.endedAt, r.notes]);
    for (const c of e.ownedCards) {
      await tx.run(
        `INSERT INTO owned_cards (id, catalog_card_id, custom_card_id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, variant, variant_detail, condition, acquisition_id, purchase_price_cents, purchase_currency, storage_location_id, scan_session_id, notes, manual_price_cents, manual_price_currency, created_at, updated_at) VALUES (${placeholders(24)})`,
        [c.id, c.catalogCardId, c.customCardId, c.name, nameSearch(c.name), c.setId, c.setName, c.localId, c.language, c.rarity, c.imageUrl, c.variant, c.variantDetail, c.condition, c.acquisitionId, c.purchasePriceCents, c.purchaseCurrency, c.storageLocationId, c.scanSessionId, c.notes, c.manualPriceCents, c.manualPriceCurrency, c.createdAt, c.updatedAt]
      );
    }
    for (const g of e.grades) await tx.run('INSERT INTO grades (id, owned_card_id, company, company_label, grade, cert_number, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [g.id, g.ownedCardId, g.company, g.companyLabel, g.grade, g.certNumber, g.notes, g.createdAt, g.updatedAt]);
    for (const m of e.collectionGroupMembers) await tx.run('INSERT INTO collection_group_members (collection_group_id, owned_card_id) VALUES (?, ?)', [m.collectionGroupId, m.ownedCardId]);
    await tx.run(
      "UPDATE app_settings SET languages_json = ?, sets_followed_json = ?, sync_all_sets = ?, hide_tcg_pocket = ?, default_currency = ?, disclaimer_acknowledged = ?, disclaimer_acknowledged_at = ?, onboarding_completed_at = ?, updated_at = ? WHERE id = 'app'",
      [JSON.stringify(s.languages), JSON.stringify(s.setsFollowed), s.syncAllSets ? 1 : 0, s.hideTcgPocket ? 1 : 0, s.defaultCurrency, s.disclaimerAcknowledged ? 1 : 0, s.disclaimerAcknowledgedAt, s.onboardingCompletedAt, s.updatedAt]
    );
  }
}
