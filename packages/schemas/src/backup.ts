import { z } from 'zod';
import { AcquisitionRow, BackupCounts, CatalogRefRow, CustomCardRow, GradeRow, GroupMemberRow, OwnedCardRow, PriceSnapshotRow, ScanSessionRow, StorageLocationRow, CollectionGroupRow } from './transfer';
import { Currency, Hash, Id, Instant, Language, Notes, ProviderId, SafeInt, SetKey } from './primitives';
import { FileRefSchema } from './api';

/** .fdx backup v1 (docs/IMPORT-EXPORT.md). FdxManifestV1 / BackupEntry / BackupCounts live in transfer.ts and are re-exported by the index. */
export const FDX_MIME = 'application/vnd.flashydex.backup+zip';
export const FDX_LIMITS = {
  archiveBytes: 512 * 1024 * 1024,
  expandedBytes: 1024 * 1024 * 1024,
  entityBytes: 128 * 1024 * 1024,
  settingsBytes: 1024 * 1024,
  manifestBytes: 256 * 1024,
  imageBytes: 10 * 1024 * 1024,
  images: 10000,
  entries: 10010,
  totalRows: 250000,
  ownedRows: 100000
} as const;

export const CatalogIdentityRow = z.object({ language: Language, id: ProviderId, createdAt: Instant }).strict();
export const CatalogAnnotationRow = z
  .object({ language: Language, catalogCardId: ProviderId, displayOverrides: z.record(z.string(), z.unknown()), notes: Notes.nullable(), createdAt: Instant, updatedAt: Instant })
  .strict();
export const UserImageRow = z
  .object({
    id: Id, ownerType: z.enum(['custom', 'owned']), ownerId: Id, mime: z.enum(['image/webp', 'image/jpeg', 'image/png']),
    extension: z.enum(['webp', 'jpg', 'png']), sha256: Hash, bytes: SafeInt, included: z.boolean()
  })
  .strict();

export const FdxEntitiesV1 = z
  .object({
    entitiesVersion: z.literal(1),
    catalogIdentities: z.array(CatalogIdentityRow),
    catalogRefs: z.array(CatalogRefRow),
    catalogAnnotations: z.array(CatalogAnnotationRow),
    customCards: z.array(CustomCardRow),
    acquisitions: z.array(AcquisitionRow),
    storageLocations: z.array(StorageLocationRow),
    collectionGroups: z.array(CollectionGroupRow),
    scanSessions: z.array(ScanSessionRow),
    ownedCards: z.array(OwnedCardRow).max(100000),
    grades: z.array(GradeRow),
    collectionGroupMembers: z.array(GroupMemberRow),
    priceSnapshots: z.array(PriceSnapshotRow),
    userImages: z.array(UserImageRow).max(10000)
  })
  .strict();
export type FdxEntitiesV1 = z.infer<typeof FdxEntitiesV1>;

export const SettingsBackupV1 = z
  .object({
    settingsVersion: z.literal(1),
    languages: z.array(Language).min(1).max(2),
    setsFollowed: z.array(SetKey).max(1000),
    syncAllSets: z.boolean(),
    hideTcgPocket: z.boolean(),
    defaultCurrency: Currency,
    disclaimerAcknowledged: z.boolean(),
    disclaimerAcknowledgedAt: Instant.nullable(),
    onboardingCompletedAt: Instant.nullable(),
    updatedAt: Instant,
    imageCacheLimitBytes: SafeInt
  })
  .strict();
export type SettingsBackupV1 = z.infer<typeof SettingsBackupV1>;

export type BackupProgress = {
  phase: 'snapshot' | 'compressing' | 'verifying' | 'staging' | 'activating' | 'complete';
  bytesDone: number;
  bytesTotal: number | null;
  cancellable: boolean;
};
export type BackupProgressCallback = (progress: BackupProgress) => void;

export type BackupCapabilities = { fdxCreate: boolean; fdxRestore: boolean; optionalCatalogPayload: boolean; reason: string | null };
export type BackupResult = { file: z.infer<typeof FileRefSchema>; format: 'fdx'; backupVersion: 1; sha256: string; counts: z.infer<typeof BackupCounts>; warnings: string[] };
export type BackupPreview = {
  id: string; backupHash: string; expiresAt: string; backupVersion: 1; counts: z.infer<typeof BackupCounts>; totalCards: number; customCards: number;
  collectionRevision: number; userStateToken: string; matchedCatalogIdentities: number; missingCatalogIdentities: number; warnings: string[];
  warning: 'Replaces all personal data';
};
export type RestoreResult = {
  restored: true; totalCards: number; counts: z.infer<typeof BackupCounts>; safetyBackup: z.infer<typeof FileRefSchema>; restoredAt: string; restartRequired: false;
};
