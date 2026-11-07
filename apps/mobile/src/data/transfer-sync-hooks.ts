import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BackupCapabilities, BackupCreate, ById, DomainError, ExportInput, FileRef, ImportCommit, ImportCommitResult, ImportDryRun, ImportReport, Input,
  PickInput, RestoreCommit, RestoreDryRun, Services, ShareInput, SyncDto, SyncStart
} from '@flashydex/core';
import { ValidationError } from '@flashydex/core';
import { useServices, useServicesIfReady } from './context';
import { invalidateAll, invalidatePersonal, keys } from './keys';
import { platform } from '../platform/app-platform';
import { useReportBackgroundJob } from '../lib/handoff';

/* ------------------------------------------------------------------------------------------ sync (secondary refresh path) */
/** Latest sync run; polls every second while it is queued/running. */
export function useActiveSync() {
  const services = useServicesIfReady();
  const query = useQuery<SyncDto | null, DomainError>({
    queryKey: keys.sync(),
    enabled: services !== null,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' || status === 'cancel_requested' ? 1000 : false;
    },
    queryFn: async () => (await (services as NonNullable<typeof services>).sync.list({ limit: 1 })).data[0] ?? null
  });
  // S7-01: an active network refresh/sync is a background job: the update handoff waits for it (busy registry) and cancels it before storage is retired.
  const active = query.data;
  const running = active?.status === 'queued' || active?.status === 'running' || active?.status === 'cancel_requested';
  useReportBackgroundJob(running, 'A catalog refresh is running.', () => {
    if (services && active && active.status !== 'cancel_requested') void services.sync.cancel({ id: active.id }).catch(() => undefined);
  });
  return query;
}
export function useStartSync() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<SyncDto, DomainError, Input<typeof SyncStart>>({ retry: false, mutationFn: (input) => services.sync.start(input), onSuccess: () => invalidateAll(qc) });
}
export function useCancelSync() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<SyncDto, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.sync.cancel(input), onSuccess: () => invalidateAll(qc) });
}
export function useResumeSync() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<SyncDto, DomainError, Input<typeof ById>>({ retry: false, mutationFn: (input) => services.sync.resume(input), onSuccess: () => invalidateAll(qc) });
}
/** "Update prices for my cards": prices_only over the distinct (language,setId) of owned catalog copies (Director note 2). */
export function useUpdateOwnedPrices() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<SyncDto, DomainError, void>({
    retry: false,
    mutationFn: async () => {
      const sets = await services.collection.ownedSetKeys();
      if (sets.length === 0) throw new ValidationError('Add cards first', [{ path: 'selection', code: 'custom', message: 'No owned catalog cards' }]);
      return services.sync.start({ mode: 'prices_only', selection: { scope: 'followed', sets } });
    },
    onSuccess: () => invalidateAll(qc)
  });
}
/** "Refresh set": refresh over exactly that set (Director note 3). */
export function useRefreshSet() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<SyncDto, DomainError, { language: 'en' | 'ja'; setId: string }>({
    retry: false,
    mutationFn: (setKey) => services.sync.start({ mode: 'refresh', selection: { scope: 'followed', sets: [setKey] } }),
    onSuccess: () => invalidateAll(qc)
  });
}

/* ------------------------------------------------------------------------------------------ transfer / backup */
export function useExportFile() {
  const services = useServices();
  return useMutation({ retry: false, mutationFn: (input: Input<typeof ExportInput>) => services.transfer.exportFile(input) });
}
export function useShareExport() {
  const services = useServices();
  return useMutation<{ outcome: 'shared' | 'downloaded' | 'cancelled' }, DomainError, Input<typeof ShareInput>>({ retry: false, mutationFn: (input) => services.transfer.shareExport(input) });
}
/** Opens the file picker. Resolves null when the user cancels (no plan, no writes). */
export function usePickFile() {
  return useMutation<FileRef | null, DomainError, Input<typeof PickInput>>({ retry: false, mutationFn: (input) => platform.filesystem.pick(input) });
}
export function useImportDryRun() {
  const services = useServices();
  return useMutation<ImportReport, DomainError, Input<typeof ImportDryRun>>({ retry: false, mutationFn: (input) => services.transfer.dryRun(input) });
}
export function useImport(id: string | undefined) {
  const services = useServicesIfReady();
  return useQuery<ImportReport, DomainError>({ queryKey: keys.importReport(id ?? ''), enabled: services !== null && id !== undefined, queryFn: () => (services as NonNullable<typeof services>).transfer.getImport({ id: id as string }) });
}
export function useImportCommit() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<ImportCommitResult, DomainError, Input<typeof ImportCommit>>({
    retry: false,
    mutationFn: (input) => services.transfer.commit(input),
    onSuccess: async () => { await invalidatePersonal(qc); }
  });
}
export function useBackupCapabilities() {
  const services = useServicesIfReady();
  return useQuery<BackupCapabilities, DomainError>({ queryKey: keys.backupCapabilities(), enabled: services !== null, queryFn: () => (services as NonNullable<typeof services>).backup.capabilities({}) });
}
type BackupApi = Services['backup'];
export type BackupResultDto = Awaited<ReturnType<BackupApi['create']>>;
export type BackupPreviewDto = Awaited<ReturnType<BackupApi['previewRestore']>>;
export type RestoreResultDto = Awaited<ReturnType<BackupApi['restore']>>;
export type BackupProgressEvent = Parameters<NonNullable<Parameters<BackupApi['create']>[1]>>[0];
type Controls = { onProgress?: (progress: BackupProgressEvent) => void; signal?: AbortSignal };

export function useCreateBackup() {
  const services = useServices();
  return useMutation<BackupResultDto, DomainError, { input: Input<typeof BackupCreate> } & Controls>({
    retry: false,
    mutationFn: ({ input, onProgress, signal }) => services.backup.create(input, onProgress, signal)
  });
}
export function usePreviewRestore() {
  const services = useServices();
  return useMutation<BackupPreviewDto, DomainError, { input: Input<typeof RestoreDryRun> } & Controls>({
    retry: false,
    mutationFn: ({ input, onProgress, signal }) => services.backup.previewRestore(input, onProgress, signal)
  });
}
/** Restore replaces ALL personal data: on success every cached query (not just `fd` ones) is refetched. */
export function useRestore() {
  const services = useServices();
  const qc = useQueryClient();
  return useMutation<RestoreResultDto, DomainError, { input: Input<typeof RestoreCommit> } & Controls>({
    retry: false,
    mutationFn: ({ input, onProgress, signal }) => services.backup.restore(input, onProgress, signal),
    onSuccess: () => qc.invalidateQueries()
  });
}

/** What the sync engine can do on this platform; the UI disables the rest with an honest caption. */
export function useSyncCapabilities(): { pricesOnly: boolean; refresh: boolean; incremental: boolean; reason: string | null } {
  const services = useServicesIfReady();
  return services ? services.sync.capabilities() : { pricesOnly: false, refresh: false, incremental: false, reason: null };
}
