/**
 * FlashyDex data layer: the ONLY surface screens import for data. TanStack Query v5 hooks over the core services
 * (docs/API.md "UI↔data hook surface"). Inputs are the core zod input types, outputs the DTO types. Errors surface as `DomainError`
 * (`code`, `message`, `details`) unchanged. No hook returns placeholder data; a service that is not built yet throws
 * `UNSUPPORTED_CAPABILITY` ("Not implemented yet").
 */
export { AppServicesProvider } from './provider';
export { useAppStartup, useServices, useStorageStatus } from './context';
export { useStartupProgress } from './startup-progress';
export { fdxMeasures } from './bootstrap';

export { useSettings, useUpdateSettings, useDashboard } from './settings-hooks';

export {
  useCollection, useOwnedCopy, useAddCopies, useUpdateCopy, useRemoveCopy, useOwnedSetKeys,
  useAcquisitions, useUpdateAcquisition,
  useLocations, useCreateLocation, useUpdateLocation, useRemoveLocation,
  useGroups, useCreateGroup, useUpdateGroup, useRemoveGroup, useAddGroupMembers, useRemoveGroupMembers,
  useCustomCard, useCustomCards, useCreateCustomCard, useUpdateCustomCard, useRemoveCustomCard
} from './collection-hooks';
export type { CollectionQuery, AddCopiesInput } from './collection-hooks';

export { useCardSearch, useCatalogCard, useSets, useSet, useSetCards, useSetCover, useSetIndex } from './catalog-hooks';
export type { SetIndexResult } from './catalog-hooks';

export { useCatalogManifest, useCatalogStatus, useCatalogInstall, useUninstallCatalog, useRollbackCatalog, isCatalogInstallActive, useCatalogInstallActive } from './install-hooks';
export type { CatalogInstallControls } from './install-hooks';

export {
  useActiveSync, useStartSync, useCancelSync, useResumeSync, useUpdateOwnedPrices, useRefreshSet, useSyncCapabilities,
  useExportFile, useShareExport, usePickFile, useImportDryRun, useImport, useImportCommit,
  useBackupCapabilities, useCreateBackup, usePreviewRestore, useRestore
} from './transfer-sync-hooks';
export type { BackupPreviewDto, BackupProgressEvent, BackupResultDto, RestoreResultDto } from './transfer-sync-hooks';

export { cardImageUrl, collectorNumber } from './images';
export { keys as dataQueryKeys } from './keys';

// Types screens need (re-exported so routes/components never import from `@flashydex/core` directly).
export type {
  AcquisitionDto, AppSettings, BackupCapabilities, CardDetail, CardSummary, CatalogProgress, CatalogStatus, CatalogUpdateCheck, CollectionCardGroup,
  Condition, Currency, CurrencyStats, CustomDto, DashboardDto, DomainError, FileRef, GradeDto, GroupDto, ImportCommitResult, ImportReport,
  InstalledCatalog, Language, LocationDto, OwnedDto, Page, PriceDto, SetIndexRow, SetSummary, SyncDto, ValuationDto, Variant
} from '@flashydex/core';
export {
  DomainError as DomainErrorClass, isDomainError
} from '@flashydex/core';
