import { z } from 'zod';
import {
  ArtUrl, Language as LanguageSchema, Name, ProviderId, AcquisitionInput, AcquisitionPatch, AcquisitionQuery, AcquisitionUpdate, BulkAdd, ById, CustomInput, CustomPatch, CustomQuery, CustomUpdate,
  MembersInput, NamedInput, NamedPatch, NamedQuery, NamedUpdate, OwnedCreate, OwnedUpdate, type AcquisitionDto, type CustomDto,
  type GroupDto, type Input, type LocationDto, type OwnedDto, type Page
} from '@flashydex/schemas';
import { nameSearch } from '../catalog/tcgdex';
import type { Exec } from '../db/sql';
import { ConflictError, InUseError, NotFoundError, ValidationError } from '../errors';
import { bumpRevision, emptyToNull, nameKeyOf, parse, type ServiceContext } from './context';
import { listOwned, type CollectionCardGroup } from './collection-list';
import { hydrateOwned } from './owned-read';

type OwnedCreateInput = ReturnType<typeof OwnedCreate.parse>;
type Language = 'en' | 'ja';

type Snapshot = {
  name: string; setId: string | null; setName: string | null; localId: string | null; language: Language; rarity: string | null; imageUrl: string | null;
};

const SnapshotSchema = z.object({
  name: Name, setId: ProviderId.nullable(), setName: z.string().min(1).max(400).nullable(), localId: z.string().min(1).max(80).nullable(),
  language: LanguageSchema, rarity: z.string().min(1).max(100).nullable(), imageUrl: ArtUrl.nullable()
}).strict();

/** The snapshot is copied into owned_cards forever: validate it (never store a malformed value such as the string "undefined"). */
function validateSnapshot(candidate: Record<string, unknown>): Snapshot {
  const result = SnapshotSchema.safeParse(candidate);
  if (!result.success) {
    throw new ValidationError('The catalog card data is not valid and cannot be copied into the collection', result.error.issues.map((issue) => ({
      path: `catalogSnapshot.${issue.path.map(String).join('.')}`, code: issue.code, message: issue.message
    })));
  }
  return result.data as Snapshot;
}

const bad = (path: string, message: string): ValidationError => new ValidationError(message, [{ path, code: 'custom', message }]);
const page = <T>(data: T[], offset: number, limit: number, total: number): Page<T> => ({ data, page: { offset, limit, total, hasMore: offset + data.length < total } });

export class CollectionRepo {
  constructor(private readonly ctx: ServiceContext) {}

  private get user() {
    return this.ctx.databases.user;
  }

  /* ------------------------------------------------------------------------------------------ copies */
  list(input: Input<typeof import('@flashydex/schemas').OwnedListQuery> & { groupBy: 'copy' }): Promise<Page<OwnedDto>>;
  list(input: Input<typeof import('@flashydex/schemas').OwnedListQuery> & { groupBy?: 'card' }): Promise<Page<CollectionCardGroup>>;
  list(input: Input<typeof import('@flashydex/schemas').OwnedListQuery>): Promise<Page<CollectionCardGroup> | Page<OwnedDto>>;
  list(input: Input<typeof import('@flashydex/schemas').OwnedListQuery>): Promise<Page<CollectionCardGroup> | Page<OwnedDto>> {
    return listOwned(this.ctx, input);
  }

  /** Distinct (language,setId) of owned catalog copies (snapshot ids): drives `prices_only` refresh selection. */
  async ownedSetKeys(): Promise<Array<{ language: 'en' | 'ja'; setId: string }>> {
    const rows = await this.user.rows('SELECT DISTINCT language, set_id FROM owned_cards WHERE catalog_card_id IS NOT NULL AND set_id IS NOT NULL ORDER BY language ASC, set_id ASC');
    return rows.map((r) => ({ language: r[0] as 'en' | 'ja', setId: String(r[1]) }));
  }

  async getCopy(input: Input<typeof ById>): Promise<OwnedDto> {
    const { id } = parse(ById, input);
    const copy = (await hydrateOwned(this.ctx, [id])).get(id);
    if (!copy) throw new NotFoundError('OwnedCard', id);
    return copy;
  }

  async add(input: Input<typeof OwnedCreate>): Promise<OwnedDto> {
    const copy = parse(OwnedCreate, input);
    const { created } = await this.createCopies(copy, 1);
    return created[0] as OwnedDto;
  }

  async bulkAdd(input: Input<typeof BulkAdd>): Promise<{ created: number; copies: OwnedDto[] }> {
    const { quantity, copy } = parse(BulkAdd, input);
    if (quantity > 1 && copy.grade && copy.grade.certNumber !== null) throw bad('copy.grade.certNumber', 'A certificate number cannot be shared by several copies');
    const { created } = await this.createCopies(copy, quantity);
    return { created: created.length, copies: created };
  }

  private async resolveSnapshot(copy: OwnedCreateInput): Promise<{ snapshot: Snapshot; prices: unknown[][] }> {
    if ((copy.catalogCardId === undefined) === (copy.customCardId === undefined)) {
      throw bad('catalogCardId', 'Exactly one of catalogCardId or customCardId is required');
    }
    if (copy.catalogCardId !== undefined) {
      const catalog = await this.ctx.databases.catalog(copy.language);
      if (!catalog) throw new NotFoundError('CatalogCard', copy.catalogCardId, `The ${copy.language} catalog is not installed`);
      const rows = await catalog.rows(
        `SELECT c.name AS card_name, c.set_id AS card_set_id, s.name AS set_name, c.local_id AS card_local_id, c.rarity AS card_rarity, c.image_url AS card_image_url FROM catalog_cards c
         LEFT JOIN catalog_sets s ON s.language = c.language AND s.id = c.set_id WHERE c.language = ? AND c.id = ?`,
        [copy.language, copy.catalogCardId]
      );
      const row = rows[0];
      if (!row) throw new NotFoundError('CatalogCard', copy.catalogCardId);
      const prices = await catalog.rows(
        `SELECT source, variant, variant_detail, provider_variant_key, currency, low_cents, mid_cents, high_cents, market_cents, trend_cents,
           source_updated_at, captured_at, observation_key FROM catalog_latest_prices WHERE language = ? AND catalog_card_id = ?`,
        [copy.language, copy.catalogCardId]
      );
      return {
        snapshot: validateSnapshot({
          name: row[0], setId: row[1], setName: row[2], localId: row[3], language: copy.language, rarity: row[4], imageUrl: row[5]
        }),
        prices
      };
    }
    const rows = await this.user.rows('SELECT name, set_id, set_name, local_id, language, rarity, image_url FROM custom_cards WHERE id = ?', [copy.customCardId]);
    const row = rows[0];
    if (!row) throw new NotFoundError('CustomCard', copy.customCardId);
    if (row[4] !== copy.language) throw bad('language', 'The custom card language does not match the copy language');
    return {
      snapshot: validateSnapshot({ name: row[0], setId: row[1], setName: row[2], localId: row[3], language: copy.language, rarity: row[5], imageUrl: row[6] }),
      prices: []
    };
  }

  private async createCopies(copy: OwnedCreateInput, quantity: number): Promise<{ created: OwnedDto[] }> {
    if (copy.variant === 'other' && copy.variantDetail.trim() === '') throw bad('variantDetail', "variant 'other' requires a variantDetail");
    if (new Set(copy.groupIds).size !== copy.groupIds.length) throw bad('groupIds', 'Group ids must be distinct');
    const { snapshot, prices } = await this.resolveSnapshot(copy);
    const now = this.ctx.env.clock.now();
    const ids: string[] = [];
    await this.user.transaction(async (tx) => {
      let acquisitionId: string | null = null;
      if (copy.acquisition && 'id' in copy.acquisition) {
        await mustExist(tx, 'acquisitions', copy.acquisition.id, 'Acquisition');
        acquisitionId = copy.acquisition.id;
      } else if (copy.acquisition) {
        acquisitionId = this.ctx.env.ids.uuid();
        const a = copy.acquisition.create;
        await tx.run('INSERT INTO acquisitions (id, purchased_on, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
          acquisitionId, a.purchasedOn, emptyToNull(a.source), emptyToNull(a.notes), now, now
        ]);
      }
      if (copy.storageLocationId) await mustExist(tx, 'storage_locations', copy.storageLocationId, 'StorageLocation');
      for (const groupId of copy.groupIds) await mustExist(tx, 'collection_groups', groupId, 'CollectionGroup');

      if (copy.catalogCardId !== undefined) {
        await tx.run('INSERT OR IGNORE INTO catalog_identities (language, id, created_at) VALUES (?, ?, ?)', [copy.language, copy.catalogCardId, now]);
        // Preserve the currently displayed catalog quotes as personal history, idempotently by observation key.
        for (const p of prices) {
          await tx.run(
            `INSERT OR IGNORE INTO price_snapshots (id, catalog_card_id, language, source, variant, variant_detail, provider_variant_key, currency,
               low_cents, mid_cents, high_cents, market_cents, trend_cents, source_updated_at, captured_at, observation_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [this.ctx.env.ids.uuid(), copy.catalogCardId, copy.language, ...p.slice(0, 11), p[11], p[12]]
          );
        }
      }
      for (let i = 0; i < quantity; i += 1) {
        const id = this.ctx.env.ids.uuid();
        ids.push(id);
        await tx.run(
          `INSERT INTO owned_cards (id, catalog_card_id, custom_card_id, name, name_search, set_id, set_name, local_id, language, rarity, image_url,
             variant, variant_detail, condition, acquisition_id, purchase_price_cents, purchase_currency, storage_location_id, scan_session_id,
             notes, manual_price_cents, manual_price_currency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          [
            id, copy.catalogCardId ?? null, copy.customCardId ?? null, snapshot.name, nameSearch(snapshot.name), snapshot.setId, snapshot.setName,
            snapshot.localId, snapshot.language, snapshot.rarity, snapshot.imageUrl, copy.variant, copy.variantDetail.trim(), copy.condition, acquisitionId,
            copy.purchasePrice?.cents ?? null, copy.purchasePrice?.currency ?? null, copy.storageLocationId, emptyToNull(copy.notes),
            copy.manualPrice?.cents ?? null, copy.manualPrice?.currency ?? null, now, now
          ]
        );
        if (copy.grade) await insertGrade(tx, this.ctx.env.ids.uuid(), id, copy.grade, now);
        for (const groupId of copy.groupIds) await tx.run('INSERT INTO collection_group_members (collection_group_id, owned_card_id) VALUES (?, ?)', [groupId, id]);
      }
      await bumpRevision(tx, now);
    });
    const hydrated = await hydrateOwned(this.ctx, ids);
    return { created: ids.map((id) => hydrated.get(id) as OwnedDto) };
  }

  async update(input: Input<typeof OwnedUpdate>): Promise<OwnedDto> {
    const { id, patch } = parse(OwnedUpdate, input);
    if (Object.keys(patch).length === 0) throw bad('patch', 'At least one field is required');
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      const rows = await tx.rows('SELECT variant, variant_detail FROM owned_cards WHERE id = ?', [id]);
      const current = rows[0];
      if (!current) throw new NotFoundError('OwnedCard', id);
      const sets: string[] = [];
      const params: unknown[] = [];
      let variant = String(current[0]);
      let detail = String(current[1]);
      if (patch.variant !== undefined) {
        if (patch.variant !== variant && patch.variantDetail === undefined) detail = '';
        variant = patch.variant;
      }
      if (patch.variantDetail !== undefined) detail = patch.variantDetail.trim();
      if (patch.variant !== undefined || patch.variantDetail !== undefined) {
        if (variant === 'other' && detail === '') throw bad('variantDetail', "variant 'other' requires a variantDetail");
        sets.push('variant = ?', 'variant_detail = ?');
        params.push(variant, detail);
      }
      if (patch.condition !== undefined) { sets.push('condition = ?'); params.push(patch.condition); }
      if (patch.purchasePrice !== undefined) { sets.push('purchase_price_cents = ?', 'purchase_currency = ?'); params.push(patch.purchasePrice?.cents ?? null, patch.purchasePrice?.currency ?? null); }
      if (patch.manualPrice !== undefined) { sets.push('manual_price_cents = ?', 'manual_price_currency = ?'); params.push(patch.manualPrice?.cents ?? null, patch.manualPrice?.currency ?? null); }
      if (patch.acquisitionId !== undefined) {
        if (patch.acquisitionId !== null) await mustExist(tx, 'acquisitions', patch.acquisitionId, 'Acquisition');
        sets.push('acquisition_id = ?'); params.push(patch.acquisitionId);
      }
      if (patch.storageLocationId !== undefined) {
        if (patch.storageLocationId !== null) await mustExist(tx, 'storage_locations', patch.storageLocationId, 'StorageLocation');
        sets.push('storage_location_id = ?'); params.push(patch.storageLocationId);
      }
      if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(emptyToNull(patch.notes)); }
      if (patch.grade !== undefined) {
        const existing = await tx.rows('SELECT id FROM grades WHERE owned_card_id = ?', [id]);
        if (patch.grade === null) {
          if (existing[0]) await tx.run('DELETE FROM grades WHERE owned_card_id = ?', [id]);
        } else if (existing[0]) {
          const g = patch.grade;
          await tx.run('UPDATE grades SET company = ?, company_label = ?, grade = ?, cert_number = ?, notes = ?, updated_at = ? WHERE owned_card_id = ?', [
            g.company, g.companyLabel, g.grade, g.certNumber, emptyToNull(g.notes), now, id
          ]);
        } else {
          await insertGrade(tx, this.ctx.env.ids.uuid(), id, patch.grade, now);
        }
      }
      if (patch.groupIds !== undefined) {
        if (new Set(patch.groupIds).size !== patch.groupIds.length) throw bad('groupIds', 'Group ids must be distinct');
        for (const groupId of patch.groupIds) await mustExist(tx, 'collection_groups', groupId, 'CollectionGroup');
        await tx.run('DELETE FROM collection_group_members WHERE owned_card_id = ?', [id]);
        for (const groupId of patch.groupIds) await tx.run('INSERT INTO collection_group_members (collection_group_id, owned_card_id) VALUES (?, ?)', [groupId, id]);
      }
      sets.push('updated_at = ?');
      params.push(now, id);
      await tx.run(`UPDATE owned_cards SET ${sets.join(', ')} WHERE id = ?`, params);
      await bumpRevision(tx, now);
    });
    return this.getCopy({ id });
  }

  async remove(input: Input<typeof ById>): Promise<void> {
    const { id } = parse(ById, input);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'owned_cards', id, 'OwnedCard');
      await tx.run('DELETE FROM owned_cards WHERE id = ?', [id]); // grade + memberships cascade
      await bumpRevision(tx, now);
    });
  }

  /* ------------------------------------------------------------------------------------------ acquisitions */
  private acquisitionSelect = {
    id: 'a.id', purchasedOn: 'a.purchased_on', source: 'a.source', notes: 'a.notes', createdAt: 'a.created_at', updatedAt: 'a.updated_at',
    copyCount: '(SELECT COUNT(*) FROM owned_cards o WHERE o.acquisition_id = a.id)'
  } as const;

  async listAcquisitions(input: Input<typeof AcquisitionQuery>): Promise<Page<AcquisitionDto>> {
    const q = parse(AcquisitionQuery, input);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.source) { where.push('instr(lower(a.source), ?) > 0'); params.push(nameKeyOf(q.source)); }
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) throw bad('from', 'from must not be after to');
    if (q.from !== undefined) { where.push('a.purchased_on >= ?'); params.push(q.from); }
    if (q.to !== undefined) { where.push('a.purchased_on <= ?'); params.push(q.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.user.read(async (r) => {
      const total = Number(await r.scalar<number>(`SELECT COUNT(*) FROM acquisitions a ${clause}`, params));
      const rows = await r.select<AcquisitionDto>(this.acquisitionSelect, `FROM acquisitions a ${clause} ORDER BY a.purchased_on IS NULL, a.purchased_on DESC, a.id ASC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]);
      return page(rows.map(fixCount), q.offset, q.limit, total);
    });
  }

  async getAcquisition(input: Input<typeof ById>): Promise<AcquisitionDto> {
    const { id } = parse(ById, input);
    const rows = await this.user.select<AcquisitionDto>(this.acquisitionSelect, 'FROM acquisitions a WHERE a.id = ?', [id]);
    if (!rows[0]) throw new NotFoundError('Acquisition', id);
    return fixCount(rows[0]);
  }

  async createAcquisition(input: Input<typeof AcquisitionInput>): Promise<AcquisitionDto> {
    const a = parse(AcquisitionInput, input);
    const id = this.ctx.env.ids.uuid();
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await tx.run('INSERT INTO acquisitions (id, purchased_on, source, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, a.purchasedOn, emptyToNull(a.source), emptyToNull(a.notes), now, now]);
      await bumpRevision(tx, now);
    });
    return this.getAcquisition({ id });
  }

  async updateAcquisition(input: Input<typeof AcquisitionUpdate>): Promise<AcquisitionDto> {
    const { id, patch } = parse(AcquisitionUpdate, input);
    if (Object.keys(AcquisitionPatch.parse(patch)).length === 0) throw bad('patch', 'At least one field is required');
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'acquisitions', id, 'Acquisition');
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.purchasedOn !== undefined) { sets.push('purchased_on = ?'); params.push(patch.purchasedOn); }
      if (patch.source !== undefined) { sets.push('source = ?'); params.push(emptyToNull(patch.source)); }
      if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(emptyToNull(patch.notes)); }
      sets.push('updated_at = ?');
      await tx.run(`UPDATE acquisitions SET ${sets.join(', ')} WHERE id = ?`, [...params, now, id]);
      await bumpRevision(tx, now);
    });
    return this.getAcquisition({ id });
  }

  async removeAcquisition(input: Input<typeof ById>): Promise<void> {
    const { id } = parse(ById, input);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'acquisitions', id, 'Acquisition');
      const used = Number(await tx.scalar<number>('SELECT COUNT(*) FROM owned_cards WHERE acquisition_id = ?', [id]));
      if (used > 0) throw new InUseError('Acquisition', used);
      await tx.run('DELETE FROM acquisitions WHERE id = ?', [id]);
      await bumpRevision(tx, now);
    });
  }

  /* ------------------------------------------------------------------------------------------ locations + groups */
  private named(kind: 'location' | 'group') {
    return kind === 'location'
      ? { table: 'storage_locations', entity: 'StorageLocation', count: '(SELECT COUNT(*) FROM owned_cards o WHERE o.storage_location_id = t.id)' }
      : { table: 'collection_groups', entity: 'CollectionGroup', count: '(SELECT COUNT(*) FROM collection_group_members m WHERE m.collection_group_id = t.id)' };
  }

  private async namedList(kind: 'location' | 'group', input: Input<typeof NamedQuery>): Promise<Page<LocationDto>> {
    const q = parse(NamedQuery, input);
    const n = this.named(kind);
    const where = q.q ? 'WHERE instr(t.name_key, ?) > 0' : '';
    const params = q.q ? [nameKeyOf(q.q)] : [];
    return this.user.read(async (r) => {
      const total = Number(await r.scalar<number>(`SELECT COUNT(*) FROM ${n.table} t ${where}`, params));
      const rows = await r.select<LocationDto>(
        { id: 't.id', name: 't.name', description: 't.description', createdAt: 't.created_at', updatedAt: 't.updated_at', copyCount: n.count },
        `FROM ${n.table} t ${where} ORDER BY t.name_key ASC, t.id ASC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]
      );
      return page(rows.map(fixCount), q.offset, q.limit, total);
    });
  }

  private async namedGet(kind: 'location' | 'group', id: string, q: Pick<Exec, 'select'> = this.user): Promise<LocationDto> {
    const n = this.named(kind);
    const rows = await q.select<LocationDto>(
      { id: 't.id', name: 't.name', description: 't.description', createdAt: 't.created_at', updatedAt: 't.updated_at', copyCount: n.count },
      `FROM ${n.table} t WHERE t.id = ?`, [id]
    );
    if (!rows[0]) throw new NotFoundError(n.entity, id);
    return fixCount(rows[0]);
  }

  private async namedCreate(kind: 'location' | 'group', input: Input<typeof NamedInput>): Promise<LocationDto> {
    const v = parse(NamedInput, input);
    const n = this.named(kind);
    const id = this.ctx.env.ids.uuid();
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      const key = nameKeyOf(v.name);
      if (Number(await tx.scalar<number>(`SELECT COUNT(*) FROM ${n.table} WHERE name_key = ?`, [key])) > 0) throw new ConflictError(`${n.entity} name already exists`, { field: 'name' });
      await tx.run(`INSERT INTO ${n.table} (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [id, v.name, key, emptyToNull(v.description), now, now]);
      await bumpRevision(tx, now);
    });
    return this.namedGet(kind, id);
  }

  private async namedUpdate(kind: 'location' | 'group', input: Input<typeof NamedUpdate>): Promise<LocationDto> {
    const { id, patch } = parse(NamedUpdate, input);
    if (Object.keys(NamedPatch.parse(patch)).length === 0) throw bad('patch', 'At least one field is required');
    const n = this.named(kind);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, n.table, id, n.entity);
      const sets: string[] = [];
      const params: unknown[] = [];
      if (patch.name !== undefined) {
        const key = nameKeyOf(patch.name);
        if (Number(await tx.scalar<number>(`SELECT COUNT(*) FROM ${n.table} WHERE name_key = ? AND id <> ?`, [key, id])) > 0) throw new ConflictError(`${n.entity} name already exists`, { field: 'name' });
        sets.push('name = ?', 'name_key = ?');
        params.push(patch.name, key);
      }
      if (patch.description !== undefined) { sets.push('description = ?'); params.push(emptyToNull(patch.description)); }
      sets.push('updated_at = ?');
      await tx.run(`UPDATE ${n.table} SET ${sets.join(', ')} WHERE id = ?`, [...params, now, id]);
      await bumpRevision(tx, now);
    });
    return this.namedGet(kind, id);
  }

  listLocations(input: Input<typeof NamedQuery>): Promise<Page<LocationDto>> { return this.namedList('location', input); }
  getLocation(input: Input<typeof ById>): Promise<LocationDto> { return this.namedGet('location', parse(ById, input).id); }
  createLocation(input: Input<typeof NamedInput>): Promise<LocationDto> { return this.namedCreate('location', input); }
  updateLocation(input: Input<typeof NamedUpdate>): Promise<LocationDto> { return this.namedUpdate('location', input); }
  async removeLocation(input: Input<typeof ById>): Promise<void> {
    const { id } = parse(ById, input);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'storage_locations', id, 'StorageLocation');
      await tx.run('UPDATE owned_cards SET storage_location_id = NULL WHERE storage_location_id = ?', [id]);
      await tx.run('DELETE FROM storage_locations WHERE id = ?', [id]);
      await bumpRevision(tx, now);
    });
  }

  listGroups(input: Input<typeof NamedQuery>): Promise<Page<GroupDto>> { return this.namedList('group', input); }
  getGroup(input: Input<typeof ById>): Promise<GroupDto> { return this.namedGet('group', parse(ById, input).id); }
  createGroup(input: Input<typeof NamedInput>): Promise<GroupDto> { return this.namedCreate('group', input); }
  updateGroup(input: Input<typeof NamedUpdate>): Promise<GroupDto> { return this.namedUpdate('group', input); }
  async removeGroup(input: Input<typeof ById>): Promise<void> {
    const { id } = parse(ById, input);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'collection_groups', id, 'CollectionGroup');
      await tx.run('DELETE FROM collection_groups WHERE id = ?', [id]); // memberships cascade, copies stay
      await bumpRevision(tx, now);
    });
  }

  private async members(input: Input<typeof MembersInput>, add: boolean): Promise<GroupDto> {
    const { id, ownedCardIds } = parse(MembersInput, input);
    if (new Set(ownedCardIds).size !== ownedCardIds.length) throw bad('ownedCardIds', 'Copy ids must be distinct');
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'collection_groups', id, 'CollectionGroup');
      for (const copyId of ownedCardIds) await mustExist(tx, 'owned_cards', copyId, 'OwnedCard');
      let changed = 0;
      for (const copyId of ownedCardIds) {
        const present = Number(await tx.scalar<number>('SELECT COUNT(*) FROM collection_group_members WHERE collection_group_id = ? AND owned_card_id = ?', [id, copyId])) > 0;
        if (add && !present) { await tx.run('INSERT INTO collection_group_members (collection_group_id, owned_card_id) VALUES (?, ?)', [id, copyId]); changed += 1; }
        if (!add && present) { await tx.run('DELETE FROM collection_group_members WHERE collection_group_id = ? AND owned_card_id = ?', [id, copyId]); changed += 1; }
      }
      if (changed > 0) await bumpRevision(tx, now); // idempotent no-ops leave the revision alone
    });
    return this.namedGet('group', id);
  }
  addMembers(input: Input<typeof MembersInput>): Promise<GroupDto> { return this.members(input, true); }
  removeMembers(input: Input<typeof MembersInput>): Promise<GroupDto> { return this.members(input, false); }

  /* ------------------------------------------------------------------------------------------ custom cards */
  private customSelect = {
    id: 'c.id', name: 'c.name', setId: 'c.set_id', setName: 'c.set_name', localId: 'c.local_id', language: 'c.language', rarity: 'c.rarity',
    imageUrl: 'c.image_url', notes: 'c.notes', createdAt: 'c.created_at', updatedAt: 'c.updated_at',
    copyCount: '(SELECT COUNT(*) FROM owned_cards o WHERE o.custom_card_id = c.id)'
  } as const;

  async listCustom(input: Input<typeof CustomQuery>): Promise<Page<CustomDto>> {
    const q = parse(CustomQuery, input);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) { where.push('instr(c.name_search, ?) > 0'); params.push(nameSearch(q.q)); }
    if (q.language) { where.push('c.language = ?'); params.push(q.language); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.user.read(async (r) => {
      const total = Number(await r.scalar<number>(`SELECT COUNT(*) FROM custom_cards c ${clause}`, params));
      const rows = await r.select<CustomDto>(this.customSelect, `FROM custom_cards c ${clause} ORDER BY c.name_search ASC, c.id ASC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset]);
      return page(rows.map(fixCount), q.offset, q.limit, total);
    });
  }

  async getCustom(input: Input<typeof ById>): Promise<CustomDto> {
    const { id } = parse(ById, input);
    const rows = await this.user.select<CustomDto>(this.customSelect, 'FROM custom_cards c WHERE c.id = ?', [id]);
    if (!rows[0]) throw new NotFoundError('CustomCard', id);
    return fixCount(rows[0]);
  }

  async createCustom(input: Input<typeof CustomInput>): Promise<CustomDto> {
    const v = parse(CustomInput, input);
    const id = this.ctx.env.ids.uuid();
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO custom_cards (id, name, name_search, set_id, set_name, local_id, language, rarity, image_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, v.name, nameSearch(v.name), v.setId, v.setName, v.localId, v.language, v.rarity, v.imageUrl, emptyToNull(v.notes), now, now]
      );
      await bumpRevision(tx, now);
    });
    return this.getCustom({ id });
  }

  async updateCustom(input: Input<typeof CustomUpdate>): Promise<CustomDto> {
    const { id, patch } = parse(CustomUpdate, input);
    if (Object.keys(CustomPatch.parse(patch)).length === 0) throw bad('patch', 'At least one field is required');
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      const rows = await tx.rows('SELECT language FROM custom_cards WHERE id = ?', [id]);
      if (!rows[0]) throw new NotFoundError('CustomCard', id);
      if (patch.language !== undefined && patch.language !== rows[0][0]) {
        const used = Number(await tx.scalar<number>('SELECT COUNT(*) FROM owned_cards WHERE custom_card_id = ?', [id]));
        if (used > 0) throw new ConflictError('The language of a custom card that has copies cannot change', { dependentCount: used });
      }
      const map: Record<string, string> = { name: 'name', setId: 'set_id', setName: 'set_name', localId: 'local_id', language: 'language', rarity: 'rarity', imageUrl: 'image_url', notes: 'notes' };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(key === 'notes' ? emptyToNull(value as string | null) : value);
        if (key === 'name') { sets.push('name_search = ?'); params.push(nameSearch(value as string)); }
      }
      sets.push('updated_at = ?');
      await tx.run(`UPDATE custom_cards SET ${sets.join(', ')} WHERE id = ?`, [...params, now, id]); // copy snapshots are never rewritten
      await bumpRevision(tx, now);
    });
    return this.getCustom({ id });
  }

  async removeCustom(input: Input<typeof ById>): Promise<void> {
    const { id } = parse(ById, input);
    const now = this.ctx.env.clock.now();
    await this.user.transaction(async (tx) => {
      await mustExist(tx, 'custom_cards', id, 'CustomCard');
      const used = Number(await tx.scalar<number>('SELECT COUNT(*) FROM owned_cards WHERE custom_card_id = ?', [id]));
      if (used > 0) throw new InUseError('CustomCard', used);
      await tx.run('DELETE FROM custom_cards WHERE id = ?', [id]);
      await bumpRevision(tx, now);
    });
  }
}

const fixCount = <T extends { copyCount: number }>(row: T): T => ({ ...row, copyCount: Number(row.copyCount) });

async function mustExist(tx: Pick<Exec, 'scalar'>, table: string, id: string, entity: string): Promise<void> {
  const count = Number(await tx.scalar<number>(`SELECT COUNT(*) FROM ${table} WHERE id = ?`, [id]));
  if (count === 0) throw new NotFoundError(entity, id);
}

async function insertGrade(tx: Exec, id: string, ownedCardId: string, g: { company: string; companyLabel: string | null; grade: string; certNumber: string | null; notes: string | null }, now: string): Promise<void> {
  await tx.run('INSERT INTO grades (id, owned_card_id, company, company_label, grade, cert_number, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id, ownedCardId, g.company, g.companyLabel, g.grade, g.certNumber, emptyToNull(g.notes), now, now
  ]);
}
