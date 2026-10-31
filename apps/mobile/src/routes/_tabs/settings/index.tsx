import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { BottomSheet, ConfirmDialog, useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { ChipGroup, Group, LinkButton, NavRow, SectionCaption, Switch, ErrorState, Button } from '../../../components/ui';
import { useCatalogInstall, useCatalogManifest, useCatalogStatus, useCustomCards, useLocations, useSettings, useUninstallCatalog, useUpdateSettings } from '../../../data';
import { describeProgress } from '../../../lib/catalog';
import { describeError } from '../../../lib/errors';
import { LANGUAGE_BADGE, LANGUAGE_NAMES, formatBytes, formatInt, type Currency, type Language } from '../../../lib/format';
import { DISCLAIMER } from '../../../lib/legal';
import { haptic, isNative } from '../../../lib/native';
import { prefs, useHapticsPref, useSearchLanguagePref, type SearchLanguage } from '../../../lib/prefs';
import { useSheetParam } from '../../../lib/sheets';
import { appVersion } from '../../../lib/native';
import { useQuery } from '@tanstack/react-query';

export const Route = createFileRoute('/_tabs/settings/')({
  validateSearch: z.object({ sheet: z.enum(['custom', 'remove']).optional().catch(undefined) }),
  component: SettingsHome
});

function SettingsHome() {
  const { sheet } = Route.useSearch();
  const sheets = useSheetParam();
  const settings = useSettings();
  const update = useUpdateSettings();
  const toast = useToast();
  const locations = useLocations({ limit: 1 });
  const custom = useCustomCards({ limit: 1 });
  const install = useCatalogInstall();
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const haptics = useHapticsPref();
  const searchLang = useSearchLanguagePref();
  const version = useQuery({ queryKey: ['app-version'], queryFn: appVersion, staleTime: Infinity });

  const catalogValue = install.active && install.progress ? `Downloading${describeProgress(install.progress.language, install.progress).percent !== null ? ` ${describeProgress(install.progress.language, install.progress).percent} %` : '…'}` : `EN ${en.data?.installed.status === 'installed' ? '✓' : '—'} · JP ${ja.data?.installed.status === 'installed' ? '✓' : '—'}`;
  const save = (patch: Parameters<typeof update.mutate>[0]) => update.mutate(patch, { onError: (e) => toast.show({ message: describeError(e).body, tone: 'negative' }) });
  const anyInstalled = en.data?.installed.status === 'installed' || ja.data?.installed.status === 'installed';

  if (settings.isError) return <Page title="Settings" large><ErrorState error={settings.error} onRetry={() => void settings.refetch()} /></Page>;

  return (
    <Page title="Settings" large>
      <SectionCaption>Card catalog</SectionCaption>
      <Group>
        <NavRow to="/settings/catalog" label="Catalog & prices" value={catalogValue} testId="row-catalog" />
      </Group>

      <SectionCaption>Your data</SectionCaption>
      <Group>
        <NavRow to="/settings/data" label="Import, export & backup" testId="row-data" />
        <NavRow to="/settings/locations" label="Storage locations" value={locations.data ? formatInt(locations.data.page.total) : undefined} testId="row-locations" />
        <NavRow label="Custom cards" value={custom.data ? formatInt(custom.data.page.total) : undefined} onClick={() => sheets.open('custom')} testId="row-custom" />
      </Group>

      <SectionCaption>Preferences</SectionCaption>
      <div className="flex flex-col gap-3 rounded-lg bg-surface px-4 py-2">
        <ChipGroup
          label="Currency"
          value={(settings.data?.defaultCurrency ?? 'USD') as Currency}
          onChange={(v) => save({ defaultCurrency: v })}
          testIdPrefix="currency"
          options={[{ value: 'USD', label: 'USD · TCGplayer' }, { value: 'EUR', label: 'EUR · Cardmarket' }]}
        />
        <ChipGroup label="Search language" value={searchLang} onChange={(v) => prefs.setSearchLanguage(v as SearchLanguage)} testIdPrefix="searchlang" options={[{ value: 'all', label: 'All' }, { value: 'en', label: 'EN' }, { value: 'ja', label: 'JP' }]} />
        <Switch checked={settings.data ? !settings.data.hideTcgPocket : false} disabled={!settings.isSuccess} onChange={(v) => save({ hideTcgPocket: !v })} label="Include TCG Pocket (digital) cards" testId="pocket-switch" />
        {isNative() && <Switch checked={haptics} onChange={(v) => { prefs.setHaptics(v); if (v) haptic('select'); }} label="Haptics" testId="haptics-switch" />}
      </div>

      <SectionCaption>About</SectionCaption>
      <Group>
        <NavRow to="/settings/about" label="About FlashyDex" value={version.data?.version} testId="row-about" />
        <NavRow to="/settings/privacy" label="Privacy policy" testId="row-privacy" />
        <NavRow to="/settings/licenses" label="Licenses" testId="row-licenses" />
      </Group>

      <SectionCaption tone="negative">Danger zone</SectionCaption>
      <Group>
        <NavRow label="Remove a downloaded catalog…" tone="negative" onClick={() => sheets.open('remove')} testId="row-remove-catalog" />
      </Group>

      <p className="selectable px-1 pb-4 pt-6 text-caption text-fg-subtle" data-testid="settings-disclaimer">{DISCLAIMER}</p>

      <CustomSheet open={sheet === 'custom'} onClose={sheets.close} />
      <RemoveSheet open={sheet === 'remove'} onClose={sheets.close} anyInstalled={!!anyInstalled} />
    </Page>
  );
}

function CustomSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useCustomCards({ limit: 50 });
  return (
    <BottomSheet open={open} title="Custom cards" leading="Close" onClose={onClose} testId="custom-sheet" footer={<LinkButton to="/custom-cards/new" variant="primary" full>New custom card</LinkButton>}>
      {list.data?.data.length ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface">
          {list.data.data.map((c) => (
            <li key={c.id}>
              <LinkButton to="/custom-cards/$customId" params={{ customId: c.id } as never} variant="text" className="w-full justify-between rounded-none px-4 text-fg">
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="text-small text-fg-muted">{LANGUAGE_BADGE[c.language]} · ×{c.copyCount}</span>
              </LinkButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-8 text-center text-body text-fg-muted">No custom cards yet.</p>
      )}
    </BottomSheet>
  );
}

function RemoveSheet({ open, onClose, anyInstalled }: { open: boolean; onClose: () => void; anyInstalled: boolean }) {
  const manifest = useCatalogManifest();
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const uninstall = useUninstallCatalog();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Language | null>(null);
  const status = { en, ja };
  const sizeOf = (l: Language) => manifest.data?.languages.find((x) => x.language === l)?.uncompressedBytes;
  const installed = (['en', 'ja'] as Language[]).filter((l) => status[l].data?.installed.status === 'installed');
  const go = async () => {
    if (!confirm) return;
    try {
      await uninstall.mutateAsync(confirm);
      haptic('deleted');
      toast.show({ message: `${LANGUAGE_NAMES[confirm]} catalog removed` });
    } catch (e) {
      toast.show({ message: describeError(e).body, tone: 'negative' });
    }
    setConfirm(null);
  };
  return (
    <BottomSheet open={open} title="Remove a catalog" leading="Close" onClose={onClose} testId="remove-sheet">
      {installed.length === 0 ? (
        <p className="py-8 text-center text-body text-fg-muted">{anyInstalled ? 'Loading…' : 'No catalog is downloaded.'}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface">
          {installed.map((l) => (
            <li key={l}>
              <Button variant="text" className="min-h-(--ps-tap-lg) w-full justify-between rounded-none px-4 text-negative" onClick={() => setConfirm(l)} data-testid={`remove-${l}`}>
                <span>{LANGUAGE_NAMES[l]}</span>
                <span className="text-small text-fg-muted">{sizeOf(l) ? `about ${formatBytes(sizeOf(l))}` : ''}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={`Remove the ${confirm ? LANGUAGE_NAMES[confirm] : ''} catalog?`}
        body={`${confirm && sizeOf(confirm) ? `This frees about ${formatBytes(sizeOf(confirm))}. ` : ''}Your cards stay in your collection — you’ll see what you saved, without prices and card info, until you download it again.`}
        confirmLabel="Remove"
        destructive
        busy={uninstall.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void go()}
        testId="remove-confirm"
      />
    </BottomSheet>
  );
}
