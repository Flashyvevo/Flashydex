import { z } from 'zod';
import {
  ArtUrl, Cents, Company, Condition, Currency, DateOnly, Hash, Id, Instant, Language, Name, Notes, ProviderId, SafeInt, Variant
} from './primitives';

/** Interchange v1 (docs/IMPORT-EXPORT.md). No computed DTO fields; derived search keys are recomputed on import. */
const Audit = { createdAt: Instant, updatedAt: Instant };

export const CatalogRefRow = z
  .object({
    id: ProviderId,
    language: Language,
    name: Name,
    setId: ProviderId,
    setName: Name.nullable(),
    localId: z.string().min(1).max(80),
    rarity: z.string().max(100).nullable(),
    imageUrl: ArtUrl.nullable()
  })
  .strict();
export const CustomCardRow = z
  .object({
    id: Id,
    name: Name,
    setId: ProviderId.nullable(),
    setName: Name.nullable(),
    localId: z.string().min(1).max(80).nullable(),
    language: Language,
    rarity: z.string().max(100).nullable(),
    imageUrl: ArtUrl.nullable(),
    notes: Notes.nullable(),
    ...Audit
  })
  .strict();
export const AcquisitionRow = z.object({ id: Id, purchasedOn: DateOnly.nullable(), source: Name.nullable(), notes: Notes.nullable(), ...Audit }).strict();
export const StorageLocationRow = z.object({ id: Id, name: Name, description: Notes.nullable(), ...Audit }).strict();
export const CollectionGroupRow = StorageLocationRow;
export const ScanSessionRow = z
  .object({
    id: Id,
    status: z.enum(['open', 'closed', 'abandoned']),
    startedAt: Instant,
    endedAt: Instant.nullable(),
    notes: Notes.nullable()
  })
  .strict();
export const OwnedCardRow = z
  .object({
    id: Id,
    catalogCardId: ProviderId.nullable(),
    customCardId: Id.nullable(),
    name: Name,
    setId: ProviderId.nullable(),
    setName: Name.nullable(),
    localId: z.string().min(1).max(80).nullable(),
    language: Language,
    rarity: z.string().max(100).nullable(),
    imageUrl: ArtUrl.nullable(),
    variant: Variant,
    variantDetail: z.string().max(120),
    condition: Condition.nullable(),
    acquisitionId: Id.nullable(),
    purchasePriceCents: Cents.nullable(),
    purchaseCurrency: Currency.nullable(),
    storageLocationId: Id.nullable(),
    scanSessionId: Id.nullable(),
    notes: Notes.nullable(),
    manualPriceCents: Cents.nullable(),
    manualPriceCurrency: Currency.nullable(),
    ...Audit
  })
  .strict();
export const GradeRow = z
  .object({
    id: Id,
    ownedCardId: Id,
    company: Company,
    companyLabel: Name.nullable(),
    grade: z.string().trim().min(1).max(16),
    certNumber: z.string().min(1).max(100).nullable(),
    notes: Notes.nullable(),
    ...Audit
  })
  .strict();
export const GroupMemberRow = z.object({ collectionGroupId: Id, ownedCardId: Id }).strict();
export const PriceSnapshotRow = z
  .object({
    id: Id,
    catalogCardId: ProviderId,
    language: Language,
    source: z.enum(['tcgplayer', 'cardmarket']),
    variant: Variant,
    variantDetail: z.string().max(120),
    providerVariantKey: ProviderId,
    currency: Currency,
    lowCents: Cents.nullable(),
    midCents: Cents.nullable(),
    highCents: Cents.nullable(),
    marketCents: Cents.nullable(),
    trendCents: Cents.nullable(),
    sourceUpdatedAt: Instant.nullable(),
    capturedAt: Instant,
    observationKey: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const CollectionExportV1 = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: Instant,
    appVersion: z.string().min(1).max(80),
    catalogRefs: z.array(CatalogRefRow),
    customCards: z.array(CustomCardRow),
    acquisitions: z.array(AcquisitionRow),
    storageLocations: z.array(StorageLocationRow),
    collectionGroups: z.array(CollectionGroupRow),
    scanSessions: z.array(ScanSessionRow),
    ownedCards: z.array(OwnedCardRow).max(100000),
    grades: z.array(GradeRow),
    collectionGroupMembers: z.array(GroupMemberRow),
    priceSnapshots: z.array(PriceSnapshotRow)
  })
  .strict();
export type CollectionExportV1 = z.infer<typeof CollectionExportV1>;
export const EXPORT_ENTITIES = [
  'catalogRefs', 'customCards', 'acquisitions', 'storageLocations', 'collectionGroups', 'scanSessions', 'ownedCards', 'grades',
  'collectionGroupMembers', 'priceSnapshots'
] as const;
export type ExportEntityName = (typeof EXPORT_ENTITIES)[number];

/* ----------------------------------------------------------------------------- dry-run / commit */
export const EntityName = z.enum(EXPORT_ENTITIES);
export const Counts = z.object({ read: SafeInt, create: SafeInt, update: SafeInt, skip: SafeInt, error: SafeInt }).strict();
const countsShape = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, Counts])) as Record<ExportEntityName, typeof Counts>;
export const EntityCounts = z.object(countsShape).strict();
export const Issue = z
  .object({
    entity: EntityName,
    row: SafeInt.nullable(),
    id: z.string().nullable(),
    code: z.string(),
    message: z.string(),
    path: z.array(z.union([z.string(), z.number().int()]))
  })
  .strict();
export const ImportCommitResult = z
  .object({
    id: Id,
    committedAt: Instant,
    collectionRevision: SafeInt,
    createdCopies: SafeInt,
    updatedCopies: SafeInt,
    skippedCopies: SafeInt,
    totalCards: SafeInt,
    counts: EntityCounts
  })
  .strict();
export const ImportReport = z
  .object({
    id: Id,
    status: z.enum(['preview', 'committed']),
    format: z.enum(['json', 'csv']),
    conflictPolicy: z.enum(['skip', 'update']),
    valid: z.boolean(),
    inputHash: Hash,
    planHash: Hash,
    createdAt: Instant,
    expiresAt: Instant,
    collectionRevision: SafeInt,
    counts: EntityCounts,
    errors: z.array(Issue).max(100),
    warnings: z.array(Issue).max(100),
    errorCount: SafeInt,
    warningCount: SafeInt,
    changes: z
      .array(z.object({ entity: EntityName, id: z.string(), action: z.enum(['create', 'update', 'skip']), changedFields: z.array(z.string()) }).strict())
      .max(100),
    changesTruncated: z.boolean(),
    result: ImportCommitResult.nullable()
  })
  .strict();
export type ImportCommitResult = z.infer<typeof ImportCommitResult>;
export type ImportReport = z.infer<typeof ImportReport>;
export type ImportIssue = z.infer<typeof Issue>;

/* ----------------------------------------------------------------------------- .fdx */
export const BackupEntry = z
  .object({ path: z.string().min(1).max(200), bytes: SafeInt, sha256: Hash, compression: z.enum(['deflate', 'store']) })
  .strict();
export const BackupCounts = z
  .object({
    ownedCards: SafeInt, customCards: SafeInt, acquisitions: SafeInt, grades: SafeInt, storageLocations: SafeInt, collectionGroups: SafeInt,
    collectionGroupMembers: SafeInt, scanSessions: SafeInt, priceSnapshots: SafeInt, catalogIdentities: SafeInt, catalogAnnotations: SafeInt,
    userImages: SafeInt
  })
  .strict();
export type FdxCounts = z.infer<typeof BackupCounts>;
export const FdxManifestV1 = z
  .object({
    format: z.literal('FlashyDex'),
    backupVersion: z.literal(1),
    entitiesVersion: z.literal(1),
    settingsVersion: z.literal(1),
    createdAt: Instant,
    appVersion: z.string().min(1).max(80),
    backupId: Id,
    entries: z.array(BackupEntry).min(2).max(10010),
    counts: BackupCounts,
    includesUserImages: z.boolean(),
    includesCatalogs: z.boolean(),
    catalogs: z
      .array(
        z
          .object({
            language: Language,
            version: z.string().min(1).max(80),
            schemaVersion: z.number().int().min(1),
            baselineSha256: Hash.nullable(),
            entryPath: z.string().max(200).nullable(),
            rawSha256: Hash.nullable(),
            uncompressedBytes: SafeInt.nullable()
          })
          .strict()
      )
      .max(2)
  })
  .strict();
