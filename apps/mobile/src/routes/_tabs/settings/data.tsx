import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { BottomSheet, ConfirmDialog, Dialog, useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { Banner, Button, ChipGroup, Group, LinkButton, SectionCaption, TextInput } from '../../../components/ui';
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
  type FileRef,
  type ImportReport
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
      const out = (await createBackup.mutateAsync({ includeUserImages: false, includeCatalogs: false })) as unknown as { file: FileRef };
      const shared = await share.mutateAsync({ files: [out.file], title: 'FlashyDex backup' });
      if (shared.outcome !== 'cancelled') {
        writeLastBackup({ at: new Date().toISOString(), totalCards: dash.data?.totalCards ?? 0 });
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
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <div>
          <Button variant="secondary" full loading={exporting === 'json'} disabled={exporting !== null} onClick={() => void doExport('json')} data-testid="export-json">
            {exporting === 'json' ? 'Preparing…' : 'Share JSON'}
          </Button>
          <p className="mt-1 text-caption text-fg-muted">Complete — use this to move to another device or app.</p>
        </div>
        <div>
          <Button variant="secondary" full loading={exporting === 'csv'} disabled={exporting !== null} onClick={() => void doExport('csv')} data-testid="export-csv">
            {exporting === 'csv' ? 'Preparing…' : 'Share CSV'}
          </Button>
          <p className="mt-1 text-caption text-fg-muted">One row per card, for spreadsheets. Some details aren’t included.</p>
        </div>
      </div>

      <SectionCaption>Backup & restore</SectionCaption>
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <div>
          <Button variant="secondary" full softDisabled={!capsReady || !canCreate} loading={backing} aria-describedby={capsReady && !canCreate ? 'backup-reason' : undefined} onClick={() => void doBackup()} data-testid="backup-create">
            Back up now
          </Button>
          <p className="mt-1 text-caption text-fg-muted">Saves your collection, settings and custom cards in one file. Card catalogs aren’t included — they download again after a restore. Save it to Files or iCloud Drive.</p>
          {lastBackup && <p className="mt-1 text-caption text-fg-muted" data-testid="last-backup">Last backup: {formatDate(lastBackup.at)} · {plural(lastBackup.totalCards, 'card')}</p>}
        </div>
        <Button variant="danger-outline" full softDisabled={!capsReady || !canRestore} aria-describedby={capsReady && !canRestore ? 'backup-reason' : undefined} onClick={() => sheets.open('restore')} data-testid="restore-file">
          Restore from backup…
        </Button>
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
            Import {plural(toAdd, 'card')}
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
          <li className="text-info">↻ {formatInt(owned.update + owned.skip)} match cards you already have</li>
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
              {[...report.errors.map((i) => ({ ...i, kind: 'Error' })), ...report.warnings.map((i) => ({ ...i, kind: 'Warning' }))].map((i, n) => (
                <li key={n} className="py-2">
                  <span className={i.kind === 'Error' ? 'text-negative' : 'text-warning'}>{i.kind}</span> {i.row ? `row ${i.row}: ` : ''}{i.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </BottomSheet>
  );
}

function RestoreSheet({ open, onClose, canRestore, reason, currentCards }: { open: boolean; onClose: () => void; canRestore: boolean; reason: string | null; currentCards: number }) {
  const pick = usePickFile();
  const preview = usePreviewRestore();
  const restore = useRestore();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);
  const p = preview.data as unknown as { id: string; backupHash: string; userStateToken: string; totalCards: number } | undefined;

  const choose = async () => {
    setError(null);
    try {
      const f = await pick.mutateAsync({ kind: 'backup', maxBytes: 512 * MB });
      if (!f) return;
      await preview.mutateAsync({ file: f });
      setConfirm(true);
    } catch (e) {
      if (!isCancelled(e)) setError(e);
    }
  };
  const doRestore = async () => {
    if (!p) return;
    setWorking(true);
    try {
      await restore.mutateAsync({ id: p.id, backupHash: p.backupHash, userStateToken: p.userStateToken, confirm: 'RESTORE' });
      haptic('added');
      toast.show({ message: `Backup restored — ${plural(p.totalCards, 'card')}` });
      setConfirm(false);
      setTyped('');
      onClose();
    } catch (e) {
      setConfirm(false);
      setError(e);
      haptic('error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <BottomSheet open={open} title="Restore from backup" leading="Close" onClose={onClose} testId="restore-sheet">
        <div className="flex flex-col gap-3 pt-2">
          <p className="text-body text-fg-muted">Restoring replaces your collection, settings and custom cards. A safety copy of your current data is kept.</p>
          <Button variant="danger-outline" full softDisabled={!canRestore} loading={pick.isPending || preview.isPending} onClick={() => void choose()} data-testid="restore-choose">
            Choose backup file
          </Button>
          {!canRestore && <p className="text-caption text-fg-muted" data-testid="restore-unsupported">{reason ?? 'Restore isn’t available on this device yet.'} This backup can be merged with Import instead.</p>}
          {error != null && <Banner tone="negative">{errorCode(error) === 'UNSUPPORTED_CAPABILITY' ? `${describeError(error).body} This backup can be merged with Import instead.` : `${describeError(error).title}. ${describeError(error).body}`}</Banner>}
        </div>
      </BottomSheet>
      <Dialog
        open={confirm && !!p}
        title="Restore this backup?"
        onDismiss={working ? undefined : () => setConfirm(false)}
        testId="restore-dialog"
        actions={
          <>
            <Button variant="danger" disabled={typed !== 'RESTORE'} loading={working} onClick={() => void doRestore()} data-testid="restore-confirm">Restore backup</Button>
            <Button onClick={() => setConfirm(false)} disabled={working}>Cancel</Button>
          </>
        }
      >
        <p>Backup: {plural(p?.totalCards ?? 0, 'card')}</p>
        <p>Now: {plural(currentCards, 'card')}</p>
        <p className="mt-2 text-small">Restoring replaces your collection, settings and custom cards. A safety copy of your current data is kept.</p>
        <label className="mt-3 block text-caption text-fg-muted" htmlFor="restore-type">Type RESTORE to confirm</label>
        <TextInput id="restore-type" autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Dialog>
      {working && (
        <div role="alert" aria-busy className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-bg" style={{ zIndex: 'var(--ps-z-blocking)' }} data-testid="blocking-overlay">
          <div className="fd-spin size-8 rounded-full border-4 border-surface-3 border-t-accent" aria-hidden />
          <p className="text-body">Restoring your backup… Keep FlashyDex open.</p>
        </div>
      )}
    </>
  );
}

export { ConfirmDialog, Group };
