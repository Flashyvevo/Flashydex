import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { Mark } from '../../../components/onboarding-shell';
import { useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { Group, NavRow } from '../../../components/ui';
import { useCatalogStatus } from '../../../data';
import { DISCLAIMER, DISCLAIMER_SECONDARY, TCGDEX_URL } from '../../../lib/legal';
import { appVersion, openExternal, useNetwork } from '../../../lib/native';

export const Route = createFileRoute('/_tabs/settings/about')({ component: AboutPage });

function AboutPage() {
  const toast = useToast();
  const net = useNetwork();
  const version = useQuery({ queryKey: ['app-version'], queryFn: appVersion, staleTime: Infinity });
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const v = (s: typeof en) => (s.data?.installed.status === 'installed' ? (s.data.installed.version ?? 'installed') : 'not downloaded');
  const link = () => (net.online ? void openExternal(TCGDEX_URL) : toast.show({ message: 'You’re offline. Connect to open this link.' }));
  return (
    <Page title="About" back={{ label: 'Settings', to: '/settings' }}>
      <div className="flex flex-col items-center gap-1 py-6 text-center">
        <span aria-hidden><Mark size={64} /></span>
        <h2 className="text-h2 font-semibold">FlashyDex</h2>
        <p className="text-small text-fg-muted" data-testid="app-version">
          Version {version.data?.version ?? '…'}
          {version.data?.build ? ` (${version.data.build})` : ''}
          {version.data && !version.data.native ? ' · web' : ''}
        </p>
      </div>
      <section aria-label="Disclaimer" className="selectable flex flex-col gap-2 rounded-lg bg-surface p-4">
        <p className="text-body" data-testid="about-disclaimer">{DISCLAIMER}</p>
        <p className="text-body text-fg-muted">{DISCLAIMER_SECONDARY}</p>
      </section>
      <h3 className="px-1 pb-1 pt-5 text-micro uppercase tracking-wide text-fg-muted">Data sources</h3>
      <Group>
        <NavRow label="Card catalog and images: TCGdex" value={<ExternalLink size={16} aria-hidden />} onClick={link} testId="tcgdex-link" />
        <div className="px-4 py-3 text-small">
          <p>Prices: TCGplayer (USD) and Cardmarket (EUR), via TCGdex</p>
          <p className="mt-1 text-caption text-fg-muted">Provided through TCGdex. FlashyDex isn’t affiliated with TCGplayer or Cardmarket. Prices may be out of date.</p>
        </div>
        <div className="px-4 py-3 text-small text-fg-muted">Catalog versions: EN {v(en)} · JP {v(ja)}</div>
      </Group>
      <div className="mt-5">
        <Group>
          <NavRow to="/settings/privacy" label="Privacy policy" />
          <NavRow to="/settings/licenses" label="Licenses" />
          <NavRow to="/settings/diagnostics" label="Diagnostics" testId="about-diagnostics" />
        </Group>
      </div>
    </Page>
  );
}
