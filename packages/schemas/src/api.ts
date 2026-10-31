import { z } from 'zod';
import { AcquisitionInput, CustomInput, GradeInput, NamedInput } from './entities';
import {
  ArtUrl, Condition, Currency, DateOnly, Empty, Hash, Id, Instant, Language, Money, Name, Notes, PageQuery, ProviderId, SetKey, Variant, ById
} from './primitives';

export { AcquisitionInput, CustomInput, GradeInput, NamedInput };

/* ----------------------------------------------------------------------------- CatalogRepo */
export const SetListQuery = PageQuery.extend({
  language: Language.optional(),
  q: z.string().trim().max(100).optional(),
  status: z.enum(['published', 'unpublished', 'all']).default('published'),
  hideTcgPocket: z.boolean().optional(),
  owned: z.boolean().optional(),
  sort: z.enum(['release_desc', 'name_asc', 'completion_desc']).default('release_desc')
}).strict();
export const SetCardsQuery = PageQuery.extend({
  ...SetKey.shape,
  ownership: z.enum(['all', 'owned', 'missing']).default('all'),
  duplicates: z.boolean().optional()
}).strict();
export const CardSearchQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  setId: ProviderId.optional(),
  localId: z.string().min(1).max(80).optional(),
  language: Language.optional(),
  rarity: z.string().min(1).max(100).optional(),
  match: z.enum(['prefix', 'contains']).default('prefix'),
  hideTcgPocket: z.boolean().optional()
}).strict();
export const CardDetailQuery = PageQuery.extend({ language: Language, cardId: ProviderId }).strict();

/* ----------------------------------------------------------------------------- CollectionRepo */
export const AcquisitionLink = z.union([z.object({ id: Id }).strict(), z.object({ create: AcquisitionInput }).strict()]);
export const OwnedCreate = z
  .object({
    language: Language,
    catalogCardId: ProviderId.optional(),
    customCardId: Id.optional(),
    variant: Variant,
    variantDetail: z.string().trim().max(120).default(''),
    condition: Condition.nullable().default(null),
    purchasePrice: Money.nullable().default(null),
    acquisition: AcquisitionLink.nullable().default(null),
    storageLocationId: Id.nullable().default(null),
    notes: Notes.nullable().default(null),
    manualPrice: Money.nullable().default(null),
    grade: GradeInput.nullable().default(null),
    groupIds: z.array(Id).max(100).default([])
  })
  .strict();
export const OwnedPatch = z
  .object({
    variant: Variant.optional(),
    variantDetail: z.string().trim().max(120).optional(),
    condition: Condition.nullable().optional(),
    purchasePrice: Money.nullable().optional(),
    acquisitionId: Id.nullable().optional(),
    storageLocationId: Id.nullable().optional(),
    notes: Notes.nullable().optional(),
    manualPrice: Money.nullable().optional(),
    grade: GradeInput.nullable().optional(),
    groupIds: z.array(Id).max(100).optional()
  })
  .strict();
export const OwnedListQuery = PageQuery.extend({
  groupBy: z.enum(['card', 'copy']).default('card'),
  q: z.string().trim().max(100).optional(),
  localId: z.string().min(1).max(80).optional(),
  setId: ProviderId.optional(),
  rarity: z.string().min(1).max(100).optional(),
  language: Language.optional(),
  condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown']).optional(),
  grading: z.enum(['raw', 'graded']).optional(),
  duplicates: z.boolean().optional(),
  storageLocationId: z.union([Id, z.literal('none')]).optional(),
  groupId: Id.optional(),
  variant: Variant.optional(),
  acquisitionId: Id.optional(),
  priced: z.enum(['none', 'some']).optional(),
  currency: Currency.optional(),
  hideTcgPocket: z.boolean().optional(),
  sort: z.enum(['created_desc', 'name_asc', 'set_asc', 'count_desc', 'value_desc', 'value_asc']).default('created_desc')
}).strict();
export const BulkAdd = z.object({ quantity: z.number().int().min(1).max(100), copy: OwnedCreate }).strict();
export const OwnedUpdate = z.object({ id: Id, patch: OwnedPatch }).strict();
export const NamedQuery = PageQuery.extend({ q: z.string().trim().max(100).optional() }).strict();
export const CustomQuery = NamedQuery.extend({ language: Language.optional() }).strict();
export const AcquisitionQuery = PageQuery.extend({
  source: z.string().max(200).optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional()
}).strict();
export const AcquisitionPatch = z
  .object({ purchasedOn: DateOnly.nullable().optional(), source: Name.nullable().optional(), notes: Notes.nullable().optional() })
  .strict();
export const NamedPatch = z.object({ name: Name.optional(), description: Notes.nullable().optional() }).strict();
// Patch schemas never carry `.default()`: omission must preserve, explicit null must clear.
export const CustomPatch = z
  .object({
    name: Name.optional(),
    setId: ProviderId.nullable().optional(),
    setName: Name.nullable().optional(),
    localId: z.string().min(1).max(80).nullable().optional(),
    language: Language.optional(),
    rarity: z.string().min(1).max(100).nullable().optional(),
    imageUrl: ArtUrl.nullable().optional(),
    notes: Notes.nullable().optional()
  })
  .strict();
export const AcquisitionUpdate = z.object({ id: Id, patch: AcquisitionPatch }).strict();
export const NamedUpdate = z.object({ id: Id, patch: NamedPatch }).strict();
export const CustomUpdate = z.object({ id: Id, patch: CustomPatch }).strict();
export const MembersInput = z.object({ id: Id, ownedCardIds: z.array(Id).min(1).max(100) }).strict();

/* ----------------------------------------------------------------------------- Portfolio / Settings */
export const DashboardInput = z.object({ currency: Currency.optional() }).strict();

export const SettingsPatch = z
  .object({
    languages: z.array(Language).min(1).max(2).optional(),
    setsFollowed: z.array(SetKey).max(1000).optional(),
    syncAllSets: z.boolean().optional(),
    hideTcgPocket: z.boolean().optional(),
    defaultCurrency: Currency.optional(),
    disclaimerAcknowledged: z.boolean().optional(),
    onboardingCompleted: z.boolean().optional()
  })
  .strict();
export type AppSettings = {
  languages: Array<z.infer<typeof Language>>;
  setsFollowed: Array<z.infer<typeof SetKey>>;
  syncAllSets: boolean;
  hideTcgPocket: boolean;
  defaultCurrency: z.infer<typeof Currency>;
  disclaimerAcknowledged: boolean;
  disclaimerAcknowledgedAt: string | null;
  onboardingCompletedAt: string | null;
  updatedAt: string;
};

/* ----------------------------------------------------------------------------- Sync */
export const Selection = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all'), sets: z.array(SetKey).max(0) }).strict(),
  z.object({ scope: z.literal('followed'), sets: z.array(SetKey).min(1).max(1000) }).strict()
]);
export const SyncStart = z
  .object({
    languages: z.array(Language).min(1).max(2).optional(),
    selection: Selection.optional(),
    mode: z.enum(['incremental', 'refresh', 'prices_only']).default('incremental')
  })
  .strict();
export type SyncDto = {
  id: string;
  status: 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  languages: Array<z.infer<typeof Language>>;
  selection: z.infer<typeof Selection>;
  mode: 'incremental' | 'refresh' | 'prices_only';
  attempt: number;
  setsTotal: number | null;
  setsDone: number;
  cardsTotal: number | null;
  cardsDone: number;
  cardsFailed: number;
  sets: Array<{
    language: z.infer<typeof Language>;
    setId: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'unpublished';
    cardsTotal: number | null;
    cardsDone: number;
    cardsFailed: number;
  }>;
  warnings: Array<{ code: string; language: z.infer<typeof Language>; cardId: string | null; message: string }>;
  lastError: { code: string; message: string; details?: unknown } | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/* ----------------------------------------------------------------------------- Catalog install */
export type CatalogPhase =
  | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'size_checked' | 'decompressing' | 'verifying' | 'validating' | 'prepared'
  | 'activating' | 'validating_active' | 'committed' | 'installed' | 'cancelled' | 'failed' | 'interrupted' | 'rolling_back';
export type CatalogProgress = {
  operationId: string;
  language: z.infer<typeof Language>;
  phase: CatalogPhase;
  compressedBytesDone: number;
  compressedBytesTotal: number | null;
  uncompressedBytesDone: number;
  uncompressedBytesTotal: number | null;
  cancellable: boolean;
  elapsedMs: number;
  warningCode: string | null;
};
export type InstalledCatalog = {
  language: z.infer<typeof Language>;
  version: string | null;
  sha256: string | null;
  installedAt: string | null;
  schemaVersion: number | null;
  generation: number;
  status: 'absent' | 'installed' | 'failed';
};
export type CatalogStatus = {
  installed: InstalledCatalog;
  job: CatalogProgress | null;
  lastError: { code: string; message: string } | null;
  rollbackAvailable: boolean;
  capabilities: { fullInstall: boolean; atomicActivation: boolean; attachReads: boolean; reason: string | null };
};
export type CatalogUpdateCheck = {
  manifestVersion: 1;
  checkedAt: string;
  languages: Array<{
    language: z.infer<typeof Language>;
    currentVersion: string | null;
    targetVersion: string;
    schemaVersion: number;
    compressedBytes: number;
    uncompressedBytes: number;
    setIndexUrl: string | null;
    /** Row counts of the pack, straight from the manifest (D12): what the download installs. */
    counts: { sets: number; cards: number; variants: number; prices: number; unpublishedSets: number };
    updateAvailable: boolean;
    compatible: boolean;
    reason: string | null;
    strategy: 'full' | 'delta';
    fallbackReason: string | null;
  }>;
};
export const CheckManifestInput = z.object({ languages: z.array(Language).min(1).max(2) }).strict().optional();
export const UninstallInput = z.object({ language: Language, confirm: z.literal(true) }).strict();

/* ----------------------------------------------------------------------------- Platform adapter */
export const FileRefSchema = z.object({ id: Id, name: z.string().min(1).max(200), mime: z.string().max(100), size: z.number().int().min(0) }).strict();
export type FileRef = z.infer<typeof FileRefSchema>;
export const PickInput = z.object({ kind: z.enum(['transfer', 'backup']), maxBytes: z.number().int().min(0) }).strict();
export const ReadInput = z.object({ file: FileRefSchema, maxBytes: z.number().int().min(0) }).strict();
export const WriteInput = z
  .object({
    name: z.string().regex(/^flashydex-[a-zA-Z0-9._-]+$/).max(200),
    mime: z.string().max(100),
    bytes: z.instanceof(Uint8Array),
    area: z.enum(['staging', 'exports'])
  })
  .strict();
export const RemoveFileInput = z.object({ file: FileRefSchema }).strict();
export const ShareInput = z.object({ files: z.array(FileRefSchema).min(1).max(2), title: Name }).strict();
export const HapticInput = z.object({ kind: z.enum(['selection', 'success', 'error']) }).strict();
export const HttpInput = z
  .object({ url: z.string().url(), method: z.literal('GET'), headers: z.record(z.string(), z.string()), timeoutMs: z.number().int().min(1).max(60000) })
  .strict();

/* ----------------------------------------------------------------------------- Transfer / backup inputs */
export const ExportInput = z.object({ format: z.enum(['json', 'csv']) }).strict();
export const ImportOptions = z.object({ format: z.enum(['json', 'csv']), conflictPolicy: z.enum(['skip', 'update']).default('skip') }).strict();
export const ImportDryRun = ImportOptions.extend({ file: FileRefSchema }).strict();
export const ImportCommit = z.object({ id: Id, planHash: Hash, confirm: z.literal(true) }).strict();
export const BackupCreate = z.object({ includeUserImages: z.boolean().default(false), includeCatalogs: z.boolean().default(false) }).strict();
export const RestoreDryRun = z.object({ file: FileRefSchema }).strict();
export const RestoreCommit = z.object({ id: Id, backupHash: Hash, userStateToken: Hash, confirm: z.literal('RESTORE') }).strict();

export { ArtUrl, Empty, Instant, ById };
