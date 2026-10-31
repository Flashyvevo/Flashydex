import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { OnboardingShell } from '../../../components/onboarding-shell';
import { useToast } from '../../../components/overlay';
import { Button, Switch, cx } from '../../../components/ui';
import { useCatalogManifest, useSetIndex, useSettings, useUpdateSettings } from '../../../data';
import { downloadTimeRange } from '../../../lib/catalog';
import { LANGUAGE_NAMES, formatBytes, formatInt, type Language } from '../../../lib/format';
import { useNetwork } from '../../../lib/native';

export const Route = createFileRoute('/_modal/welcome/languages')({ component: Languages });

type ManifestLang = { language: Language; compressedBytes: number; uncompressedBytes: number; counts?: { sets: number; cards: number; unpublishedSets?: number } };

function LanguageCard({ language, checked, onToggle, manifest, offline }: { language: Language; checked: boolean; onToggle: () => void; manifest: ManifestLang | undefined; offline: boolean }) {
  const index = useSetIndex(language);
  const sets = (index.data?.rows ?? []) as { totalCount: number | null; status: string }[];
  const published = sets.filter((s) => s.status !== 'unpublished');
  // D12: the manifest `counts` are the truth for what this download installs; the set index (every set TCGdex lists) is only a fallback.
  const fromManifest = manifest?.counts ? { sets: Math.max(0, manifest.counts.sets - (manifest.counts.unpublishedSets ?? 0)), cards: manifest.counts.cards } : null;
  const shownSets = fromManifest?.sets ?? published.length;
  const cards = fromManifest?.cards ?? published.reduce((n, s) => n + (s.totalCount ?? 0), 0);
  const approx = fromManifest ? cards : Math.round(cards / 100) * 100;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-testid={`lang-${language}`}
      onClick={onToggle}
      className={cx('flex min-h-18 w-full items-start gap-3 rounded-lg border p-4 text-left', checked ? 'border-accent bg-surface' : 'border-border bg-surface')}
    >
      <span aria-hidden className={cx('mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border', checked ? 'border-accent bg-accent text-on-accent' : 'border-border-input')}>
        {checked && <Check size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold">{LANGUAGE_NAMES[language]}</span>
        <span className="block text-caption text-fg-muted">
          {shownSets ? `${formatInt(shownSets)} ${shownSets === 1 ? 'set' : 'sets'} · ${fromManifest ? '' : 'about '}${formatInt(approx)} ${approx === 1 ? 'card' : 'cards'}` : 'Card count unavailable offline'}
        </span>
        <span className="block text-caption text-fg-muted">
          {manifest ? `${formatBytes(manifest.compressedBytes)} download · about ${formatBytes(manifest.uncompressedBytes)} on device` : `— download · — on device`}
        </span>
        {offline && !manifest && <span className="block text-caption text-fg-muted">You’re offline. Choose now — the download starts when you’re connected.</span>}
        {language === 'ja' && <span className="block text-caption text-fg-muted">Many older Japanese cards have no pictures in the catalog yet.</span>}
      </span>
    </button>
  );
}

const EN_DEFAULT: Language[] = ['en'];
const JA_DEFAULT: Language[] = ['en', 'ja'];

function Languages() {
  const navigate = useNavigate();
  const settings = useSettings();
  const update = useUpdateSettings();
  const manifest = useCatalogManifest();
  const net = useNetwork();
  const toast = useToast();
  const [selected, setSelected] = useState<Language[] | null>(null);
  const [showPocket, setShowPocket] = useState<boolean | null>(null);

  const defaultLangs = navigator.language?.toLowerCase().startsWith('ja') ? JA_DEFAULT : EN_DEFAULT;
  const pocket = showPocket ?? (settings.data ? !settings.data.hideTcgPocket : false);
  const langs = selected ?? defaultLangs;

  const entries = ((manifest.data?.languages ?? []) as ManifestLang[]).reduce<Partial<Record<Language, ManifestLang>>>((m, e) => ({ ...m, [e.language]: e }), {});
  const total = useMemo(() => langs.reduce((n, l) => n + (entries[l]?.compressedBytes ?? 0), 0), [langs, entries]);

  const toggle = (l: Language) => setSelected((cur) => { const base = cur ?? defaultLangs; return base.includes(l) ? base.filter((x) => x !== l) : [...base, l]; });

  const save = async () => {
    try {
      await update.mutateAsync({ languages: langs.length ? langs : ['en'], hideTcgPocket: !pocket });
      void navigate({ to: '/welcome/sets' });
    } catch {
      toast.show({ message: 'Couldn’t save that choice. Try again.', tone: 'negative' });
    }
  };

  return (
    <OnboardingShell
      step={3}
      title="Which cards do you collect?"
      footer={
        <>
          <Button variant="primary" full data-testid="languages-continue" disabled={langs.length === 0} loading={update.isPending} onClick={() => void save()}>
            Continue
          </Button>
          <SkipNotNow />
        </>
      }
    >
      <div className="flex flex-col gap-2" role="group" aria-label="Languages">
        {(['en', 'ja'] as Language[]).map((l) => (
          <LanguageCard key={l} language={l} checked={langs.includes(l)} onToggle={() => toggle(l)} manifest={entries[l]} offline={!net.online || manifest.isError} />
        ))}
      </div>
      <div className="rounded-lg bg-surface px-4">
        <Switch checked={pocket} onChange={setShowPocket} label="Include TCG Pocket (digital) cards" testId="pocket-switch" />
      </div>
      <p className="text-small text-fg-muted" aria-live="polite" data-testid="download-total">
        {total > 0 ? `Total: ${formatBytes(total)} · ${downloadTimeRange(total)} on Wi-Fi` : 'Total: —'}
      </p>
    </OnboardingShell>
  );
}

function SkipNotNow() {
  const navigate = useNavigate();
  const update = useUpdateSettings();
  return (
    <Button
      variant="text"
      data-testid="languages-not-now"
      loading={update.isPending}
      onClick={() => void update.mutateAsync({ onboardingCompleted: true, disclaimerAcknowledged: true }).then(() => navigate({ to: '/', replace: true }))}
    >
      Not now — I’ll add cards myself
    </Button>
  );
}
