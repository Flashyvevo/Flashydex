import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { BottomSheet, ConfirmDialog, Dialog, useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { ActionRow, Banner, Button, ChipGroup, Group, LinkButton, SectionCaption, TextInput } from '../../../components/ui';
import { ArchiveRestore, FileJson, FileSpreadsheet, HardDriveDownload, Share2 } from 'lucide-react';
import {
  useBackupCapabilities,
  useCreateBackup,
  useDashboard,
  useExportFile,
  useImportCommit,
  useImportDryRun,
  usePickFile,
  usePreviewRestore,
  useRestore,
  useShareExport,
  type BackupPreviewDto,
  type BackupProgressEvent,
  type FileRef,
  type ImportReport,
  type RestoreResultDto
} from '../../../data';
import { describeError, errorCode, isCancelled } from '../../../lib/errors';
import { formatDate, formatInt, plural } from '../../../lib/format';
import { BACKUP_SENTENCE } from '../../../lib/legal';
import { haptic } from '../../../lib/native';
import { useLastBackup, writeLastBackup } from '../../../lib/prefs';
import { useSheetParam } from '../../../lib/sheets';

export const Route = createFileRoute('/_tabs/settings/data')({
  validateSearch: z.object({ sheet: z.enum(['import', 'restore']).optional().catch(undefined) }),
  component: DataPage
});

const MB = 1024 * 1024;

function DataPage() {
  const { sheet } = Route.useSearch();
  const sheets = useSheetParam();
  const toast = useToast();
  const dash = useDashboard();
  const caps = useBackupCapabilities();
  const lastBackup = useLastBackup();

  /* ── import ── */
  const pick = usePickFile();
  const dryRun = useImportDryRun();
  const commit = useImportCommit();
  const [file, setFile] = useState<FileRef | null>(null);
  const [policy, setPolicy] = useState<'skip' | 'update'>('skip');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [importError, setImportError] = useState<unknown>(null);
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);

  const runDry = async (f: FileRef, p: 'skip' | 'update') => {
    setImportError(null);
    try {
      const format = /\.csv$/i.test(f.name) || f.mime.includes('csv') ? 'csv' : 'json';
      const r = await dryRun.mutateAsync({ format, conflictPolicy: p, file: f });
      setReport(r);
      return true;
    } catch (e) {
      setImportError(e);
      return false;
    }
  };
  const chooseFile = async () => {
    setResult(null);
    try {
      const f = await pick.mutateAsync({ kind: 'transfer', maxBytes: 25 * MB });
      if (!f) return;
      setFile(f);
      if (await runDry(f, policy)) sheets.open('import');
    } catch (e) {
      if (!isCancelled(e)) setImportError(e);
    }
  };
  const doCommit = async () => {
    if (!report) return;
    try {
      const r = await commit.mutateAsync({ id: report.id, planHash: report.planHash, confirm: true });
      haptic('added');
      setResult({ created: r.createdCopies + r.updatedCopies, skipped: r.skippedCopies });
      setReport(null);
      sheets.close();
    } catch (e) {
      haptic('error');
      setImportError(e);
    }
  };

  /* ── export ── */
  const exportFile = useExportFile();
  const share = useShareExport();
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);
  const doExport = async (format: 'json' | 'csv') => {
    setExporting(format);
    try {
      const out = await exportFile.mutateAsync({ format });
      const shared = await share.mutateAsync({ files: [out.file], title: 'FlashyDex export' });
      if (shared.outcome === 'shared') toast.show({ message: 'Export ready' });
      else if (shared.outcome === 'downloaded') toast.show({ message: `Downloaded ${out.file.name}` });
    } catch (e) {
      if (!isCancelled(e)) {
        haptic('error');
        toast.show({ message: describeError(e).body, tone: 'negative' });
      }
    } finally {
      setExporting(null);
    }
  };

  /* ── backup ── */
  const createBackup = useCreateBackup();
  const [backing, setBacking] = useState(false);
  const doBackup = async () => {
    setBacking(true);
    try {
      const out = await createBackup.mutateAsync({ input: { includeUserImages: false, includeCatalogs: false } });
      const shared = await share.mutateAsync({ files: [out.file], title: 'FlashyDex backup' });
      if (shared.outcome !== 'cancelled') {
        writeLastBackup({ at: new Date().toISOString(), totalCards: out.counts.ownedCards });
        toast.show({ message: shared.outcome === 'downloaded' ? `Downloaded ${out.file.name}` : 'Backup ready' });
      }
    } catch (e) {
      if (!isCancelled(e)) {
        haptic('error');
        toast.show({ message: describeError(e).body, tone: 'negative' });
      }
    } finally {
      setBacking(false);
    }
  };

  const capsReady = caps.isSuccess;
  const canCreate = !!caps.data?.fdxCreate;
  const canRestore = !!caps.data?.fdxRestore;
  const reason = caps.data?.reason ?? null;

  return (
    <Page title="Import, export & backup" back={{ label: 'Settings', to: '/settings' }}>
      <SectionCaption>Import</SectionCaption>
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <p className="text-small text-fg-muted">Bring in cards from a FlashyDex JSON export or a CSV file.</p>
        <Button variant="primary" full loading={pick.isPending || dryRun.isPending} onClick={() => void chooseFile()} data-testid="import-file">
          Choose file
        </Button>
        {result && (
          <Banner tone="positive" testId="import-result" action={<LinkButton to="/collection" variant="text">View collection</LinkButton>}>
            Imported {plural(result.created, 'card')}. {result.skipped > 0 ? `${plural(result.skipped, 'row')} skipped.` : ''}
          </Banner>
        )}
        {importError != null && sheet !== 'import' && (
          <Banner tone="negative" testId="import-error">
            <strong className="block">{describeError(importError).title}</strong>
            {describeError(importError).body}
            {describeError(importError).detail && <span className="mt-1 block text-caption text-fg-muted selectable" data-testid="error-detail">Details: {describeError(importError).detail}</span>}
          </Banner>
        )}
      </div>

      <SectionCaption>Export</SectionCaption>
      <Group>
        <ActionRow
          icon={FileJson}
          trailingIcon={Share2}
          label={exporting === 'json' ? 'Preparing…' : 'Share JSON'}
          description="Use this to move your collection to another device. Notes and prices you entered are included."
          loading={exporting === 'json'}
          disabled={exporting === 'csv'}
          onClick={() => void doExport('json')}
          testId="export-json"
        />
        <ActionRow
          icon={FileSpreadsheet}
          trailingIcon={Share2}
          label={exporting === 'csv' ? 'Preparing…' : 'Share CSV'}
          description="One row per copy, for spreadsheets. Price history isn’t included."
          loading={exporting === 'csv'}
          disabled={exporting === 'json'}
          onClick={() => void doExport('csv')}
          testId="export-csv"
        />
      </Group>

      <SectionCaption>Backup & restore</SectionCaption>
      <Group>
        <ActionRow
          icon={HardDriveDownload}
          label="Back up now"
          description="Saves your collection, settings and custom cards in one file. Card catalogs aren’t included — they download again after a restore. Save it to Files or iCloud Drive."
          loading={backing}
          disabled={!capsReady || !canCreate}
          disabledNote={capsReady && !canCreate ? 'Unavailable' : undefined}
          describedBy={capsReady && !canCreate ? 'backup-reason' : undefined}
          onClick={() => void doBackup()}
          testId="backup-create"
        />
        <ActionRow
          icon={ArchiveRestore}
          tone="negative"
          label="Restore from backup…"
          description="Replaces your collection with the contents of a backup file."
          disabled={!capsReady || !canRestore}
          disabledNote={capsReady && !canRestore ? 'Unavailable' : undefined}
          describedBy={capsReady && !canRestore ? 'backup-reason' : undefined}
          onClick={() => sheets.open('restore')}
          testId="restore-file"
        />
      </Group>
      <div className="mt-2 flex flex-col gap-1 px-1">
        {lastBackup && <p className="text-caption text-fg-muted" data-testid="last-backup">Last backup: {formatDate(lastBackup.at)} · {plural(lastBackup.totalCards, 'card')}</p>}
        {capsReady && (!canCreate || !canRestore) && (
          <p id="backup-reason" className="text-caption text-fg-muted" data-testid="backup-reason">
            {reason ?? 'Backup files aren’t available on this device yet.'} This backup can be merged with Import instead.
          </p>
        )}
        <p className="text-caption text-fg-subtle">{BACKUP_SENTENCE}</p>
      </div>
      <p className="px-1 pt-3 text-caption text-fg-muted">
        <Link to="/settings/about" className="hidden">format</Link>
      </p>

      <ImportPreview
        open={sheet === 'import' && !!report}
        report={report}
        file={file}
        policy={policy}
        busy={dryRun.isPending}
        error={importError}
        onPolicy={(p) => {
          setPolicy(p);
          if (file) void runDry(file, p);
        }}
        committing={commit.isPending}
        onCommit={() => void doCommit()}
        onClose={sheets.close}
      />
      <RestoreSheet open={sheet === 'restore'} onClose={sheets.close} canRestore={canRestore} reason={reason} currentCards={dash.data?.totalCards ?? 0} />
    </Page>
  );
}

function ImportPreview({ open, report, file, policy, busy, error, onPolicy, committing, onCommit, onClose }: { open: boolean; report: ImportReport | null; file: FileRef | null; policy: 'skip' | 'update'; busy: boolean; error: unknown; onPolicy: (p: 'skip' | 'update') => void; committing: boolean; onCommit: () => void; onClose: () => void }) {
  if (!open || !report) return null;
  const owned = report.counts.ownedCards;
  const attention = report.warningCount;
  const toAdd = owned.create + (policy === 'update' ? owned.update : 0);
  return (
    <BottomSheet
      open
      large
      title="Import preview"
      onClose={onClose}
      testId="import-preview"
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="primary" full disabled={!report.valid || toAdd === 0} loading={committing} onClick={onCommit} data-testid="import-commit">
            Import {plural(toAdd, 'copy', 'copies')}
          </Button>
          <Button variant="text" onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-body font-semibold">{file?.name ?? 'Import'}</p>
        <ul className="flex flex-col gap-1 text-body" data-testid="import-counts">
          <li>{formatInt(owned.read)} rows read</li>
          <li className="text-positive">✓ {formatInt(owned.create)} will be added</li>
          <li className="text-info">↻ {formatInt(owned.update + owned.skip)} match copies you already have</li>
          {attention > 0 && <li className="text-warning">⚠ {formatInt(attention)} need attention</li>}
          {owned.error > 0 && <li className="text-negative">✕ {formatInt(owned.error)} will be skipped (errors)</li>}
        </ul>
        {report.format === 'csv' && <p className="text-caption text-fg-muted">CSV files don’t carry every detail (for example price history).</p>}
        <ChipGroup label="If a row matches a copy you already have" value={policy} onChange={onPolicy} testIdPrefix="policy" options={[{ value: 'skip', label: 'Skip it' }, { value: 'update', label: 'Update my copy' }]} />
        {busy && <p className="text-caption text-fg-muted" role="status">Updating preview…</p>}
        {error != null && <Banner tone="negative">{describeError(error).body}</Banner>}
        {report.errors.length + report.warnings.length > 0 && (
          <details className="rounded-lg bg-surface">
            <summary className="flex min-h-(--ps-tap) cursor-pointer items-center px-4 text-body">Row details (first {Math.min(100, report.errors.length + report.warnings.length)})</summary>
            <ul className="selectable divide-y divide-border px-4 pb-2 text-small">
              {[...report.errors.map((i) => ({ ...i, kind: 'Can’t import' })), ...report.warnings.map((i) => ({ ...i, kind: 'Check this' }))].map((i, n) => (
                <li key={n} className="py-2">
                  <span className={i.kind === 'Can’t import' ? 'text-negative' : 'text-warning'}>{i.kind}</span> {i.row ? `row ${i.row}: ` : ''}{i.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </BottomSheet>
  );
}

const PHASE_COPY: Record<BackupProgressEvent['phase'], string> = {
  snapshot: 'Saving a safety copy of your current data…',
  compressing: 'Packing your data…',
  verifying: 'Checking the backup…',
  staging: 'Preparing the restore…',
  activating: 'Restoring your backup…',
  complete: 'Finishing up…'
};

function RestoreSheet({ open, onClose, canRestore, reason, currentCards }: { open: boolean; onClose: () => void; canRestore: boolean; reason: string | null; currentCards: number }) {
  const pick = usePickFile();
  const preview = usePreviewRestore();
  const restore = useRestore();
  const share = useShareExport();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  const [phase, setPhase] = useState<BackupProgressEvent['phase'] | null>(null);
  const [done, setDone] = useState<RestoreResultDto | null>(null);
  const [p, setPreview] = useState<BackupPreviewDto | null>(null);

  const reset = () => {
    setConfirm(false);
    setTyped('');
    setPreview(null);
  };
  const choose = async () => {
    setError(null);
    setDone(null);
    try {
      const f = await pick.mutateAsync({ kind: 'backup', maxBytes: 512 * MB });
      if (!f) return;
      setPreview(await preview.mutateAsync({ input: { file: f } }));
      setConfirm(true);
    } catch (e) {
      if (!isCancelled(e)) setError(e);
    }
  };
  const doRestore = async () => {
    if (!p) return;
    setWorking(true);
    setPhase(null);
    try {
      const out = await restore.mutateAsync({
        input: { id: p.id, backupHash: p.backupHash, userStateToken: p.userStateToken, confirm: 'RESTORE' },
        onProgress: (progress) => setPhase(progress.phase)
      });
      haptic('added');
      toast.show({ message: `Backup restored — ${plural(out.totalCards, 'card')}` });
      reset();
      setDone(out);
    } catch (e) {
      reset();
      setError(e);
      haptic('error');
    } finally {
      setWorking(false);
      setPhase(null);
    }
  };
  const shareSafety = async () => {
    if (!done) return;
    try {
      await share.mutateAsync({ files: [done.safetyBackup], title: 'FlashyDex safety copy' });
    } catch (e) {
      if (!isCancelled(e)) toast.show({ message: describeError(e).body, tone: 'negative' });
    }
  };
  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };
  const counts = p?.counts;

  return (
    <>
      <BottomSheet open={open} title="Restore from backup" leading="Close" onClose={close} testId="restore-sheet">
        <div className="flex flex-col gap-3 pt-2">
          {done ? (
            <div className="flex flex-col gap-3" data-testid="restore-done">
              <Banner tone="positive">Backup restored — {plural(done.totalCards, 'card')}.</Banner>
              <p className="text-body text-fg-muted">
                A safety copy of what was here before is saved as <span className="selectable font-medium text-fg" data-testid="safety-backup-name">{done.safetyBackup.name}</span>. Keep it until you’ve checked your collection.
              </p>
              <Button variant="secondary" full onClick={() => void shareSafety()} data-testid="safety-backup-share">Save the safety copy</Button>
              <Button variant="primary" full onClick={close}>Done</Button>
            </div>
          ) : (
            <>
              <p className="text-body text-fg-muted">Restoring replaces your collection, settings and custom cards. A safety copy of your current data is kept.</p>
              <Button variant="danger-outline" full softDisabled={!canRestore} loading={pick.isPending || preview.isPending} onClick={() => void choose()} data-testid="restore-choose">
                Choose backup file
              </Button>
              {!canRestore && <p className="text-caption text-fg-muted" data-testid="restore-unsupported">{reason ?? 'Restore isn’t available on this device yet.'} This backup can be merged with Import instead.</p>}
              {error != null && (
                <Banner tone="negative" testId="restore-error">
                  {errorCode(error) === 'UNSUPPORTED_CAPABILITY' ? `${describeError(error).body} This backup can be merged with Import instead.` : `${describeError(error).title}. ${describeError(error).body}`}
                </Banner>
              )}
            </>
          )}
        </div>
      </BottomSheet>
      <Dialog
        open={confirm && !!p}
        title="Restore this backup?"
        onDismiss={working ? undefined : reset}
        testId="restore-dialog"
        actions={
          <>
            <Button variant="danger" disabled={typed !== 'RESTORE'} loading={working} onClick={() => void doRestore()} data-testid="restore-confirm">Restore backup</Button>
            <Button onClick={reset} disabled={working}>Cancel</Button>
          </>
        }
      >
        <div className="max-h-[50dvh] overflow-y-auto" data-testid="restore-preview">
          <p className="font-semibold text-negative" data-testid="restore-warning">{p?.warning ?? 'Replaces all personal data'}</p>
          <p className="mt-2">Backup: {plural(p?.totalCards ?? 0, 'card')}{p && p.customCards > 0 ? ` · ${plural(p.customCards, 'custom card')}` : ''}</p>
          <p>Now: {plural(currentCards, 'card')}</p>
          {counts && (
            <ul className="mt-2 list-inside list-disc text-small text-fg-muted" data-testid="restore-counts">
              <li>{formatInt(counts.ownedCards)} owned {counts.ownedCards === 1 ? 'copy' : 'copies'}</li>
              <li>{plural(counts.storageLocations, 'location')} · {plural(counts.collectionGroups, 'group')}</li>
              <li>{plural(counts.acquisitions, 'purchase record')} · {plural(counts.grades, 'grade')}</li>
              <li>{plural(counts.priceSnapshots, 'saved price')}</li>
            </ul>
          )}
          {p && (
            <p className="mt-2 text-small" data-testid="restore-catalog">
              Catalog: {formatInt(p.matchedCatalogIdentities)} cards match your installed catalog
              {p.missingCatalogIdentities > 0 ? `, ${formatInt(p.missingCatalogIdentities)} aren’t installed yet — they keep their saved details and link up when the catalog downloads.` : '.'}
            </p>
          )}
          {p && p.warnings.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-small text-warning" data-testid="restore-warnings">
              {p.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <p className="mt-2 text-small">Restoring replaces your collection, settings and custom cards. A safety copy of your current data is kept.</p>
          <label className="mt-3 block text-caption text-fg-muted" htmlFor="restore-type">Type RESTORE to confirm</label>
          <TextInput id="restore-type" autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      </Dialog>
      {working && (
        <div role="alert" aria-busy className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-bg" style={{ zIndex: 'var(--ps-z-blocking)' }} data-testid="blocking-overlay">
          <div className="fd-spin size-8 rounded-full border-4 border-surface-3 border-t-accent" aria-hidden />
          <p className="text-body">{phase ? PHASE_COPY[phase] : 'Restoring your backup…'} Keep FlashyDex open.</p>
        </div>
      )}
    </>
  );
}

export { ConfirmDialog, Group };
