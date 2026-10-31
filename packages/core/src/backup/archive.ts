import { Unzip, UnzipInflate, UnzipPassThrough, zipSync, type Zippable } from 'fflate';
import {
  FDX_LIMITS, FdxEntitiesV1, FdxManifestV1, SettingsBackupV1, type FdxCounts
} from '@flashydex/schemas';
import { BackupError } from '../errors';
import { canonicalJson, observationKeyOf } from '../transfer/import-plan';
import { nameKeyOf } from '../services/context';

export type FdxLimits = { [K in keyof typeof FDX_LIMITS]: number };
export const DEFAULT_LIMITS: FdxLimits = { ...FDX_LIMITS };
export type Hasher = (bytes: Uint8Array) => Promise<string>;

export type FdxManifest = ReturnType<typeof FdxManifestV1.parse>;
export type Entities = FdxEntitiesV1;
export type Settings = SettingsBackupV1;

export type ParsedBackup = {
  manifest: FdxManifest;
  entities: Entities;
  settings: Settings;
  /** Validated image bytes by archive path (only present when included). */
  images: Map<string, Uint8Array>;
};

const enc = new TextEncoder();
const IMAGE_PATH = /^images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(webp|jpg|png)$/i;
const FIXED = new Set(['manifest.json', 'entities.json', 'settings.json']);

export const countsOf = (e: Entities): FdxCounts => ({
  ownedCards: e.ownedCards.length, customCards: e.customCards.length, acquisitions: e.acquisitions.length, grades: e.grades.length,
  storageLocations: e.storageLocations.length, collectionGroups: e.collectionGroups.length, collectionGroupMembers: e.collectionGroupMembers.length,
  scanSessions: e.scanSessions.length, priceSnapshots: e.priceSnapshots.length, catalogIdentities: e.catalogIdentities.length,
  catalogAnnotations: e.catalogAnnotations.length, userImages: e.userImages.length
});

export const totalRows = (e: Entities): number =>
  e.ownedCards.length + e.customCards.length + e.acquisitions.length + e.grades.length + e.storageLocations.length + e.collectionGroups.length +
  e.collectionGroupMembers.length + e.scanSessions.length + e.priceSnapshots.length + e.catalogIdentities.length + e.catalogAnnotations.length +
  e.catalogRefs.length + e.userImages.length;

/* ------------------------------------------------------------------------------------------------ build */
export async function buildArchive(input: {
  entities: Entities; settings: Settings; createdAt: string; appVersion: string; backupId: string;
  images?: Array<{ path: string; bytes: Uint8Array }>; hash: Hasher; catalogs?: FdxManifest['catalogs'];
}): Promise<{ bytes: Uint8Array; manifest: FdxManifest }> {
  const entitiesBytes = enc.encode(JSON.stringify(input.entities));
  const settingsBytes = enc.encode(JSON.stringify(input.settings));
  const images = input.images ?? [];
  const entries: FdxManifest['entries'] = [
    { path: 'entities.json', bytes: entitiesBytes.byteLength, sha256: await input.hash(entitiesBytes), compression: 'deflate' },
    { path: 'settings.json', bytes: settingsBytes.byteLength, sha256: await input.hash(settingsBytes), compression: 'deflate' }
  ];
  for (const img of images) entries.push({ path: img.path, bytes: img.bytes.byteLength, sha256: await input.hash(img.bytes), compression: 'store' });
  const manifest: FdxManifest = {
    format: 'FlashyDex', backupVersion: 1, entitiesVersion: 1, settingsVersion: 1, createdAt: input.createdAt, appVersion: input.appVersion,
    backupId: input.backupId, entries, counts: countsOf(input.entities), includesUserImages: images.length > 0, includesCatalogs: false, catalogs: input.catalogs ?? []
  };
  const mtime = Date.parse(input.createdAt);
  const zippable: Zippable = {
    'manifest.json': [enc.encode(JSON.stringify(manifest)), { level: 6, mtime }],
    'entities.json': [entitiesBytes, { level: 6, mtime }],
    'settings.json': [settingsBytes, { level: 6, mtime }]
  };
  for (const img of images) zippable[img.path] = [img.bytes, { level: 0, mtime }];
  return { bytes: zipSync(zippable), manifest };
}

/* ------------------------------------------------------------------------------------------------ read */
type CentralEntry = { name: string; method: number };

/** Central directory scan: names, flags, symlinks. Sizes are NOT trusted anywhere. */
function readCentralDirectory(data: Uint8Array, limits: FdxLimits): CentralEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new BackupError('BACKUP_INVALID', 'The file is not a valid backup archive');
  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || offset === 0xffffffff) throw new BackupError('BACKUP_INVALID', 'ZIP64 archives are not supported');
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) throw new BackupError('BACKUP_INVALID', 'Multi-disk archives are not supported');
  if (total > limits.entries) throw new BackupError('SIZE_LIMIT', 'The backup has too many entries');
  const out: CentralEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (let n = 0; n < total; n += 1) {
    if (offset + 46 > data.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new BackupError('BACKUP_INVALID', 'The archive directory is damaged');
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const external = view.getUint32(offset + 38, true);
    if (offset + 46 + nameLen > data.byteLength) throw new BackupError('BACKUP_INVALID', 'The archive directory is damaged');
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen));
    if ((flags & 1) !== 0 || (flags & 0x40) !== 0) throw new BackupError('BACKUP_INVALID', 'Encrypted backups are not supported');
    if (method !== 0 && method !== 8) throw new BackupError('BACKUP_INVALID', 'Unsupported compression method');
    if ((madeBy >> 8) === 3 && ((external >>> 16) & 0xf000) === 0xa000) throw new BackupError('BACKUP_UNSAFE_ENTRY', 'Symbolic links are not allowed in a backup');
    out.push({ name, method });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function checkName(name: string): void {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '.')) {
    throw new BackupError('BACKUP_UNSAFE_ENTRY', 'The backup contains an unsafe path');
  }
  if (!FIXED.has(name) && !IMAGE_PATH.test(name)) throw new BackupError('BACKUP_INVALID', 'The backup contains an unexpected entry');
}

function capFor(name: string, limits: FdxLimits): number {
  if (name === 'manifest.json') return limits.manifestBytes;
  if (name === 'entities.json') return limits.entityBytes;
  if (name === 'settings.json') return limits.settingsBytes;
  return limits.imageBytes;
}

/** Inflate every entry with a running byte counter on the ACTUAL output; aborts the moment a cap is crossed. */
function inflateAll(data: Uint8Array, names: Set<string>, limits: FdxLimits): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  let expanded = 0;
  let failure: BackupError | null = null;
  unzip.onfile = (file) => {
    if (failure) return;
    if (result.has(file.name) || !names.has(file.name)) { failure = new BackupError('BACKUP_INVALID', 'The archive entries do not match its directory'); return; }
    const cap = capFor(file.name, limits);
    const chunks: Uint8Array[] = [];
    let size = 0;
    result.set(file.name, new Uint8Array(0));
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { failure = new BackupError('BACKUP_INVALID', 'The archive could not be decompressed'); file.terminate(); return; }
      size += chunk.byteLength;
      expanded += chunk.byteLength;
      if (size > cap || expanded > limits.expandedBytes) {
        failure = new BackupError('SIZE_LIMIT', 'The backup expands beyond the allowed size');
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.byteLength; }
        result.set(file.name, out);
      }
    };
    file.start();
  };
  try {
    // Feed in slices so a bomb is stopped without inflating the rest of the archive.
    const slice = 1024 * 1024;
    for (let at = 0; at < data.byteLength && !failure; at += slice) {
      unzip.push(data.subarray(at, Math.min(at + slice, data.byteLength)), at + slice >= data.byteLength);
    }
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof BackupError) throw error;
    throw new BackupError('BACKUP_INVALID', 'The archive could not be read');
  }
  if (failure) throw failure;
  return result;
}

const decodeJson = (bytes: Uint8Array, what: string): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BackupError('BACKUP_INVALID', `${what} is not valid JSON`);
  }
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function versionGate(raw: unknown, field: string, what: string): void {
  if (!isObject(raw)) throw new BackupError('BACKUP_INVALID', `${what} must be an object`);
  if (raw[field] !== 1) {
    if (typeof raw[field] === 'number' && Number.isInteger(raw[field])) throw new BackupError('BACKUP_VERSION_UNSUPPORTED', `Unsupported ${field}`);
    throw new BackupError('BACKUP_INVALID', `${what} has no valid ${field}`);
  }
}

export async function parseArchive(
  data: Uint8Array, hash: Hasher, limitsIn: Partial<FdxLimits> = {}
): Promise<ParsedBackup> {
  const limits: FdxLimits = { ...DEFAULT_LIMITS, ...limitsIn };
  if (data.byteLength > limits.archiveBytes) throw new BackupError('SIZE_LIMIT', 'The backup file is too large');
  if (data.byteLength < 22 || data[0] !== 0x50 || data[1] !== 0x4b) throw new BackupError('BACKUP_INVALID', 'The file is not a FlashyDex backup');

  let central: CentralEntry[];
  try {
    central = readCentralDirectory(data, limits);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('BACKUP_INVALID', 'The archive directory is damaged');
  }
  const names = new Set<string>();
  for (const entry of central) {
    checkName(entry.name);
    if (names.has(entry.name)) throw new BackupError('BACKUP_INVALID', 'The backup contains a duplicate entry');
    names.add(entry.name);
  }
  for (const required of FIXED) if (!names.has(required)) throw new BackupError('BACKUP_INVALID', `The backup is missing ${required}`);
  if (names.size - FIXED.size > limits.images) throw new BackupError('SIZE_LIMIT', 'The backup has too many images');

  const files = inflateAll(data, names, limits);
  for (const n of names) if (!files.has(n)) throw new BackupError('BACKUP_INVALID', 'The archive entries do not match its directory');

  // ---- manifest
  const rawManifest = decodeJson(files.get('manifest.json')!, 'manifest.json');
  versionGate(rawManifest, 'backupVersion', 'manifest.json');
  for (const f of ['entitiesVersion', 'settingsVersion']) if (isObject(rawManifest) && typeof rawManifest[f] === 'number' && rawManifest[f] !== 1) throw new BackupError('BACKUP_VERSION_UNSUPPORTED', `Unsupported ${f}`);
  const m = FdxManifestV1.safeParse(rawManifest);
  if (!m.success) throw new BackupError('BACKUP_INVALID', 'manifest.json is not valid');
  const manifest = m.data;
  if (manifest.includesCatalogs || manifest.catalogs.some((c) => c.entryPath !== null)) throw new BackupError('BACKUP_INVALID', 'Catalog payloads are not supported');

  // ---- entries vs manifest vs actual
  const listed = new Set<string>();
  const compressionOf = new Map(central.map((c) => [c.name, c.method]));
  for (const entry of manifest.entries) {
    if (entry.path === 'manifest.json' || listed.has(entry.path) || !names.has(entry.path)) throw new BackupError('BACKUP_INVALID', 'The manifest entry list does not match the archive');
    listed.add(entry.path);
    const bytes = files.get(entry.path)!;
    if ((entry.compression === 'store') !== (compressionOf.get(entry.path) === 0)) throw new BackupError('BACKUP_INVALID', 'The manifest compression does not match the archive');
    if (bytes.byteLength !== entry.bytes || (await hash(bytes)) !== entry.sha256) throw new BackupError('BACKUP_HASH_MISMATCH', `${entry.path} does not match its recorded hash`);
  }
  for (const n of names) if (n !== 'manifest.json' && !listed.has(n)) throw new BackupError('BACKUP_INVALID', 'The archive has an entry the manifest does not list');

  // ---- entities / settings
  const rawEntities = decodeJson(files.get('entities.json')!, 'entities.json');
  versionGate(rawEntities, 'entitiesVersion', 'entities.json');
  let rows = 0;
  for (const [k, v] of Object.entries(rawEntities as Record<string, unknown>)) if (Array.isArray(v)) { rows += v.length; if (k === 'ownedCards' && v.length > limits.ownedRows) throw new BackupError('SIZE_LIMIT', 'The backup has too many cards'); }
  if (rows > limits.totalRows) throw new BackupError('SIZE_LIMIT', 'The backup has too many rows');
  const e = FdxEntitiesV1.safeParse(rawEntities);
  if (!e.success) throw new BackupError('BACKUP_INVALID', 'entities.json is not valid');
  const rawSettings = decodeJson(files.get('settings.json')!, 'settings.json');
  versionGate(rawSettings, 'settingsVersion', 'settings.json');
  const s = SettingsBackupV1.safeParse(rawSettings);
  if (!s.success) throw new BackupError('BACKUP_INVALID', 'settings.json is not valid');

  const entities = e.data;
  const settings = s.data;
  if (totalRows(entities) > limits.totalRows) throw new BackupError('SIZE_LIMIT', 'The backup has too many rows');
  const counts = countsOf(entities);
  for (const k of Object.keys(counts) as Array<keyof FdxCounts>) if (counts[k] !== manifest.counts[k]) throw new BackupError('BACKUP_COUNT_MISMATCH', `Manifest count for ${k} does not match the data`);

  // ---- images (Phase 1 core stores no image bytes, but the archive must be coherent)
  const images = new Map<string, Uint8Array>();
  const imagePaths = [...names].filter((n) => n.startsWith('images/'));
  const included = entities.userImages.filter((u) => u.included);
  if (imagePaths.length !== included.length || manifest.includesUserImages !== imagePaths.length > 0) throw new BackupError('BACKUP_COUNT_MISMATCH', 'Image entries do not match the image index');
  for (const row of included) {
    const path = `images/${row.id}.${row.extension}`;
    const bytes = files.get(path);
    const entry = manifest.entries.find((x) => x.path === path);
    if (!bytes || !entry || row.bytes !== bytes.byteLength || row.sha256 !== entry.sha256) throw new BackupError('BACKUP_HASH_MISMATCH', 'An image does not match its index row');
    images.set(path, bytes);
  }

  validateReferences(entities, settings);
  return { manifest, entities, settings, images };
}

/* ------------------------------------------------------------------------------------------------ semantic validation */
function bad(message: string): never {
  throw new BackupError('BACKUP_INVALID', message);
}

function unique<T>(label: string, rows: readonly T[], key: (row: T) => string): Set<string> {
  const seen = new Set<string>();
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) bad(`Duplicate ${label}`);
    seen.add(k);
  }
  return seen;
}

/** Strict cross-row validation: unique keys, every FK resolves INSIDE the archive, DB CHECK semantics, observation keys. */
export function validateReferences(e: Entities, settings: Settings): void {
  const identities = unique('catalog identity', e.catalogIdentities, (r) => `${r.language}\0${r.id}`);
  const customs = unique('custom card', e.customCards, (r) => r.id);
  const acquisitions = unique('acquisition', e.acquisitions, (r) => r.id);
  const locations = unique('storage location', e.storageLocations, (r) => r.id);
  const groups = unique('group', e.collectionGroups, (r) => r.id);
  const scans = unique('scan session', e.scanSessions, (r) => r.id);
  const owned = unique('owned card', e.ownedCards, (r) => r.id);
  unique('grade', e.grades, (r) => r.id);
  unique('price snapshot', e.priceSnapshots, (r) => r.id);
  unique('annotation', e.catalogAnnotations, (r) => `${r.language}\0${r.catalogCardId}`);
  unique('catalog ref', e.catalogRefs, (r) => `${r.language}\0${r.id}`);
  unique('image', e.userImages, (r) => r.id);
  unique('storage location name', e.storageLocations, (r) => nameKeyOf(r.name));
  unique('group name', e.collectionGroups, (r) => nameKeyOf(r.name));
  unique('grade owner', e.grades, (r) => r.ownedCardId);
  unique('group member', e.collectionGroupMembers, (r) => `${r.collectionGroupId}\0${r.ownedCardId}`);
  unique('observation key', e.priceSnapshots, (r) => r.observationKey);

  for (const r of e.catalogRefs) if (!identities.has(`${r.language}\0${r.id}`)) bad('A catalog reference has no identity row');
  for (const r of e.catalogAnnotations) if (!identities.has(`${r.language}\0${r.catalogCardId}`)) bad('An annotation references an unknown card identity');
  for (const p of e.priceSnapshots) {
    if (!identities.has(`${p.language}\0${p.catalogCardId}`)) bad('A price snapshot references an unknown card identity');
    if (observationKeyOf(p) !== p.observationKey) bad('A price snapshot observationKey does not match its observation');
    if (!((p.source === 'tcgplayer' && p.currency === 'USD') || (p.source === 'cardmarket' && p.currency === 'EUR'))) bad('A price snapshot has an invalid source/currency pair');
  }
  for (const c of e.ownedCards) {
    if ((c.catalogCardId === null) === (c.customCardId === null)) bad('An owned card must reference exactly one of catalog or custom card');
    if (c.catalogCardId !== null) {
      if (!identities.has(`${c.language}\0${c.catalogCardId}`)) bad('An owned card references an unknown card identity');
      if (c.setId === null || c.localId === null) bad('An owned catalog card has an incomplete snapshot');
    }
    if (c.customCardId !== null && !customs.has(c.customCardId)) bad('An owned card references an unknown custom card');
    if (c.acquisitionId !== null && !acquisitions.has(c.acquisitionId)) bad('An owned card references an unknown acquisition');
    if (c.storageLocationId !== null && !locations.has(c.storageLocationId)) bad('An owned card references an unknown storage location');
    if (c.scanSessionId !== null && !scans.has(c.scanSessionId)) bad('An owned card references an unknown scan session');
    if (c.variant === 'other' && c.variantDetail.trim() === '') bad('An owned card with variant other needs a variant detail');
    if ((c.purchasePriceCents === null) !== (c.purchaseCurrency === null)) bad('An owned card has half a purchase price');
    if ((c.manualPriceCents === null) !== (c.manualPriceCurrency === null)) bad('An owned card has half a manual price');
  }
  for (const g of e.grades) {
    if (!owned.has(g.ownedCardId)) bad('A grade references an unknown owned card');
    if (g.company === 'other' && (g.companyLabel === null || g.companyLabel.trim() === '')) bad('A grade with company other needs a label');
  }
  for (const m of e.collectionGroupMembers) {
    if (!groups.has(m.collectionGroupId) || !owned.has(m.ownedCardId)) bad('A group member references an unknown group or card');
  }
  for (const s of e.scanSessions) if ((s.status === 'open') !== (s.endedAt === null)) bad('A scan session has an inconsistent end time');
  for (const u of e.userImages) {
    if (u.ownerType === 'custom' ? !customs.has(u.ownerId) : !owned.has(u.ownerId)) bad('An image references an unknown owner');
  }
  if (settings.disclaimerAcknowledged !== (settings.disclaimerAcknowledgedAt !== null)) bad('Settings disclaimer fields are inconsistent');
  if (new Set(settings.languages).size !== settings.languages.length) bad('Settings languages must be unique');
}

export const entitiesEqual = (a: Entities, b: Entities): boolean => canonicalJson(a) === canonicalJson(b);
