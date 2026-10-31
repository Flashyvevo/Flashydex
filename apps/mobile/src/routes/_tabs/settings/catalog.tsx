import { createFileRoute } from '@tanstack/react-router';
import { Check, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { BottomSheet, ConfirmDialog, Dialog, useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { SetPicker, setKeyString, type SetKey } from '../../../components/set-picker';
import { ProgressCard } from '../../../components/sync';
import { Banner, Button, Group, NavRow, OfflineChip, SectionCaption, Skeleton, ChipGroup } from '../../../components/ui';
import {
  useActiveSync,
  useCancelSync,
  useCatalogInstall,
  useCatalogManifest,
  useCatalogStatus,
  useDashboard,
  useResumeSync,
  useSettings,
  useSyncCapabilities,
  useUpdateOwnedPrices,
  useUpdateSettings
} from '../../../data';
import { describeProgress, failureCopy, failureReason } from '../../../lib/catalog';
import { describeError, errorCode, isCancelled } from '../../../lib/errors';
import { LANGUAGE_NAMES, formatBytes, formatDate, formatInt, plural, type Language } from '../../../lib/format';
import { haptic, useNetwork } from '../../../lib/native';
import { useSheetParam } from '../../../lib/sheets';

export const Route = createFileRoute('/_tabs/settings/catalog')({
  validateSearch: z.object({ sheet: z.enum(['sets']).optional().catch(undefined) }),
  component: CatalogPage
});

type ManifestLang = { language: Language; currentVersion: string | null; targetVersion: string; compressedBytes: number; uncompressedBytes: number; updateAvailable: boolean; compatible: boolean; reason: string | null };

function CatalogPage() {
  const { sheet } = Route.useSearch();
  const manifest = useCatalogManifest();
  const net = useNetwork();
  const install = useCatalogInstall();
  const settings = useSettings();
  const [cellular, setCellular] = useState<Language | null>(null);
  const [lastError, setLastError] = useState<Partial<Record<Language, string>>>({});
  const entries = ((manifest.data?.languages ?? []) as ManifestLang[]).reduce<Partial<Record<Language, ManifestLang>>>((m, e) => ({ ...m, [e.language]: e }), {});
  const sheets = useSheetParam();

  const begin = async (language: Language) => {
    setLastError((e) => ({ ...e, [language]: undefined }));
    const result = await install.start(language);
    if (result === null) {
      // `start` never throws; the failure lands in `install.error` — read it from the persisted status below.
      setLastError((cur) => ({ ...cur, [language]: 'FAILED' }));
    }
  };
  const request = (language: Language) => {
    const bytes = entries[language]?.compressedBytes ?? 0;
    if (net.cellular && bytes > 50 * 1024 * 1024) setCellular(language);
    else void begin(language);
  };

  return (
    <Page title="Catalog & prices" back={{ label: 'Settings', to: '/settings' }} large>
      <SectionCaption>Languages</SectionCaption>
      <Group>
        {(['en', 'ja'] as Language[]).map((l) => (
          <LanguageRow key={l} language={l} entry={entries[l]} offline={!net.online} manifestError={manifest.isError} onDownload={() => request(l)} errorCode={lastError[l]} loadingManifest={manifest.isPending} />
        ))}
      </Group>
      {manifest.isError && <p className="mt-2 text-caption text-fg-muted">Couldn’t check for catalogs{net.online ? '' : ' — you’re offline'}. Installed catalogs still work.</p>}

      <PricesSection />

      <SectionCaption>Sets I collect</SectionCaption>
      <Group>
        <NavRow
          label="Sets I collect"
          testId="sets-i-collect"
          value={settings.data ? (settings.data.syncAllSets || settings.data.setsFollowed.length === 0 ? 'All sets' : plural(settings.data.setsFollowed.length, 'set')) : '—'}
          onClick={() => sheets.open('sets')}
        />
      </Group>
      <p className="px-1 pt-1 text-caption text-fg-muted">Used for the Sets tab and for price updates. Doesn’t change the download.</p>

      <div className="mt-5">
        <Group>
          <NavRow
            label="Check for updates"
            testId="check-updates"
            value={manifest.isFetching ? 'Checking…' : <RefreshCw size={16} aria-hidden />}
            onClick={() => void manifest.refetch()}
          />
        </Group>
        <p className="px-1 pt-1 text-caption text-fg-muted" aria-live="polite">
          {manifest.data ? `Last checked ${formatDate(manifest.data.checkedAt, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}` : manifest.isError ? 'Last check failed.' : ''}
        </p>
      </div>

      <SetsSheet open={sheet === 'sets'} onClose={sheets.close} />
      <Dialog
        open={cellular !== null}
        title="Download on cellular?"
        onDismiss={() => setCellular(null)}
        actions={
          <>
            <Button variant="primary" onClick={() => { const l = cellular; setCellular(null); if (l) void begin(l); }}>
              Download now
            </Button>
            <Button onClick={() => setCellular(null)}>Wait for Wi-Fi</Button>
          </>
        }
      >
        The {cellular ? LANGUAGE_NAMES[cellular] : ''} catalog is {formatBytes(cellular ? entries[cellular]?.compressedBytes : null)}.
      </Dialog>
    </Page>
  );
}

function LanguageRow({
  language,
  entry,
  offline,
  manifestError,
  onDownload,
  errorCode: lastCode,
  loadingManifest
}: {
  language: Language;
  entry: ManifestLang | undefined;
  offline: boolean;
  manifestError: boolean;
  onDownload: () => void;
  errorCode?: string;
  loadingManifest: boolean;
}) {
  const status = useCatalogStatus(language);
  const install = useCatalogInstall();
  const [confirmStop, setConfirmStop] = useState(false);
  const name = LANGUAGE_NAMES[language];
  const installed = status.data?.installed;
  const isInstalled = installed?.status === 'installed';
  const running = install.active && install.progress?.language === language;
  const progress = install.progress?.language === language ? install.progress : null;
  const failedHere = !!lastCode;
  const code = failedHere || (!running && !isInstalled) ? (install.error?.code ?? status.data?.lastError?.code) : undefined;
  void progress;

  if (running && progress) {
    const d = describeProgress(language, progress);
    return (
      <div className="p-2" data-testid={`catalog-language-${language}`}>
        <ProgressCard
          title={name}
          line={d.line}
          stageLine={d.stage === 'downloading' ? 'Downloading' : d.stage === 'checking' ? 'Checking' : d.stage === 'installing' ? 'Installing' : 'Activating'}
          value={d.value}
          max={d.max}
          valueText={d.valueText}
          actions={
            install.progress?.cancellable !== false && (
              <Button onClick={() => setConfirmStop(true)} data-testid="catalog-cancel">
                Cancel
              </Button>
            )
          }
        />
        <ConfirmDialog
          open={confirmStop}
          title="Stop downloading?"
          body="Your current catalog stays as it is."
          confirmLabel="Stop"
          cancelLabel="Keep downloading"
          destructive
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            install.cancel();
          }}
        />
      </div>
    );
  }

  const failure = code ? failureCopy(failureReason(code)) : null;
  const reasonId = `catalog-reason-${language}`;
  const needsNet = offline;
  return (
    <div className="flex flex-col gap-1 px-4 py-3" data-testid={`catalog-language-${language}`}>
      <div className="flex min-h-(--ps-tap) items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-body font-semibold">
            {name}
            {isInstalled && <Check size={18} className="text-positive" aria-label="Installed" />}
          </div>
          {isInstalled ? (
            <div className="text-caption text-fg-muted">
              Catalog {installed?.version ?? ''}
              {entry && entry.currentVersion === installed?.version ? ` · about ${formatBytes(entry.uncompressedBytes)} on this device` : ''}
            </div>
          ) : (
            <div className="text-caption text-fg-muted">
              {entry ? `${formatBytes(entry.compressedBytes)} download · uses about ${formatBytes(entry.uncompressedBytes)}` : loadingManifest ? <Skeleton className="mt-1 h-4 w-40" /> : manifestError ? 'Download size unavailable' : 'Not downloaded'}
            </div>
          )}
        </div>
        {isInstalled && entry?.updateAvailable && entry.compatible ? (
          <Button variant="secondary" softDisabled={needsNet} aria-describedby={needsNet ? reasonId : undefined} onClick={onDownload} data-testid={`catalog-download-${language}`}>
            Update · {formatBytes(entry.compressedBytes)}
          </Button>
        ) : !isInstalled ? (
          <Button variant="primary" softDisabled={needsNet || (!entry && !loadingManifest)} aria-describedby={needsNet ? reasonId : undefined} onClick={onDownload} data-testid={`catalog-download-${language}`}>
            {failure?.retry ? 'Retry' : 'Download'}
          </Button>
        ) : null}
      </div>
      {needsNet && !isInstalled && (
        <p id={reasonId} className="flex items-center gap-2 text-caption text-fg-muted">
          <OfflineChip /> Connect to the internet to download
        </p>
      )}
      {needsNet && isInstalled && entry?.updateAvailable && (
        <p id={reasonId} className="text-caption text-fg-muted">
          Connect to the internet to download
        </p>
      )}
      {language === 'ja' && !isInstalled && <p className="text-caption text-fg-muted">Many older Japanese cards have no pictures in the catalog yet.</p>}
      {failure && !isInstalled && (
        <Banner tone={failureReason(code) === 'schema' ? 'warning' : 'negative'}>
          {failure.text}
        </Banner>
      )}
      {entry && !entry.compatible && <Banner tone="warning">{describeError({ code: 'APP_UPDATE_REQUIRED' }).body} Update the app from the App Store.</Banner>}
    </div>
  );
}

function PricesSection() {
  const dash = useDashboard();
  const net = useNetwork();
  const sync = useActiveSync();
  const update = useUpdateOwnedPrices();
  const syncCaps = useSyncCapabilities();
  const cancel = useCancelSync();
  const resume = useResumeSync();
  const toast = useToast();
  const run = sync.data ?? null;
  const active = run && (run.status === 'running' || run.status === 'queued' || run.status === 'cancel_requested');
  const owned = dash.data?.totalCards ?? 0;
  const activeWork = errorCode(update.error) === 'ACTIVE_SYNC' || errorCode(update.error) === 'ACTIVE_WORK';

  const start = async () => {
    try {
      await update.mutateAsync();
      haptic('select');
    } catch (e) {
      if (!isCancelled(e)) toast.show({ message: describeError(e).body, tone: 'negative' });
    }
  };

  let reason: string | null = null;
  if (!syncCaps.pricesOnly) reason = syncCaps.reason ?? 'Price updates aren’t available yet';
  else if (!net.online) reason = 'Connect to the internet to update prices';
  else if (owned === 0) reason = 'Add cards first';
  else if (activeWork || active) reason = 'Starts when the current download finishes';

  return (
    <>
      <SectionCaption>Prices</SectionCaption>
      <div className="rounded-lg bg-surface p-4">
        {run && run.mode === 'prices_only' && (active || run.status === 'interrupted' || run.status === 'cancelled' || run.status === 'failed') ? (
          <ProgressCard
            testId="prices-progress"
            title="Updating prices"
            line={run.cardsTotal ? `${formatInt(run.cardsDone)} / ${formatInt(run.cardsTotal)} cards` : plural(run.cardsDone, 'card')}
            stageLine={
              run.status === 'cancel_requested'
                ? 'Stopping…'
                : run.status === 'cancelled' || run.status === 'interrupted'
                  ? `Paused at ${formatInt(run.cardsDone)}${run.cardsTotal ? ` of ${formatInt(run.cardsTotal)}` : ''} cards. Everything downloaded so far is kept.`
                  : run.status === 'failed'
                    ? `Stopped at ${plural(run.cardsDone, 'card')}. Everything downloaded so far is kept.`
                    : run.cardsFailed > 0
                      ? `${formatInt(run.cardsFailed)} failed`
                      : 'Downloading prices'
            }
            tone={run.cardsFailed > 0 ? 'warning' : undefined}
            value={run.cardsTotal ? run.cardsDone : null}
            max={run.cardsTotal}
            valueText={`Updating prices, ${run.cardsDone} of ${run.cardsTotal ?? 'unknown'} cards`}
            actions={
              active ? (
                <Button disabled={run.status === 'cancel_requested'} onClick={() => cancel.mutate({ id: run.id })}>
                  Pause
                </Button>
              ) : (
                <Button variant="primary" softDisabled={!net.online} onClick={() => resume.mutate({ id: run.id })}>
                  Resume
                </Button>
              )
            }
          />
        ) : (
          <>
            <p className="text-small text-fg-muted">{owned > 0 ? `My cards: ${formatInt(owned)} ${owned === 1 ? 'card' : 'cards'} · about ${Math.max(1, Math.ceil(owned / 25))} s` : 'Prices are saved for the cards you own.'}</p>
            <Button className="mt-3" variant="primary" full softDisabled={reason !== null} aria-describedby={reason ? 'prices-reason' : undefined} loading={update.isPending} onClick={() => void start()} data-testid="prices-update">
              Update prices
            </Button>
            {reason && (
              <p id="prices-reason" className="mt-2 text-caption text-fg-muted">
                {reason}
              </p>
            )}
          </>
        )}
        {run && run.status === 'completed' && run.mode === 'prices_only' && (
          <p className="mt-2 text-caption text-fg-muted">
            Last update: prices for {formatInt(run.cardsDone - run.cardsFailed)} of {formatInt(run.cardsTotal ?? run.cardsDone)} cards.
          </p>
        )}
      </div>
    </>
  );
}

function SetsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();
  const languages = (settings.data?.languages ?? ['en']) as Language[];
  const [all, setAll] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<Map<string, SetKey> | null>(null);
  if (!open) return null;
  const isAll = all ?? (settings.data ? settings.data.syncAllSets || settings.data.setsFollowed.length === 0 : true);
  const map = picked ?? new Map((settings.data?.setsFollowed ?? []).map((k) => [setKeyString(k as SetKey), k as SetKey]));
  const toggle = (k: SetKey) => {
    const next = new Map(map);
    const key = setKeyString(k);
    if (next.has(key)) next.delete(key);
    else next.set(key, k);
    setPicked(next);
  };
  const save = async () => {
    try {
      await update.mutateAsync(isAll || map.size === 0 ? { syncAllSets: true, setsFollowed: [] } : { syncAllSets: false, setsFollowed: [...map.values()] });
      onClose();
      toast.show({ message: 'Saved' });
    } catch (e) {
      toast.show({ message: describeError(e).body, tone: 'negative' });
    }
  };
  return (
    <BottomSheet
      open
      large
      title="Sets I collect"
      onClose={onClose}
      testId="sets-sheet"
      footer={
        <Button variant="primary" full loading={update.isPending} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <ChipGroup label="Scope" hideLabel value={isAll ? 'all' : 'pick'} onChange={(v) => setAll(v === 'all')} options={[{ value: 'all', label: 'All sets' }, { value: 'pick', label: 'Only sets I pick' }]} />
        {!isAll && <SetPicker languages={languages} selected={new Set(map.keys())} onToggle={toggle} hideTcgPocket={settings.data?.hideTcgPocket ?? true} />}
      </div>
    </BottomSheet>
  );
}
