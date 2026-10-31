import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { Page } from '../../../components/page';
import { NavRow, Group } from '../../../components/ui';
import { PRIVACY_SECTIONS, PRIVACY_SUMMARY, PRIVACY_UPDATED, PRIVACY_URL } from '../../../lib/legal';
import { openExternal, useNetwork } from '../../../lib/native';
import { useToast } from '../../../components/overlay';

export const Route = createFileRoute('/_tabs/settings/privacy')({ component: PrivacyPage });

function PrivacyPage() {
  const toast = useToast();
  const net = useNetwork();
  return (
    <Page title="Privacy policy" large back={{ label: 'Settings', to: '/settings' }}>
      <p className="text-caption text-fg-muted">Last updated: {PRIVACY_UPDATED}</p>
      <section aria-label="Summary" data-testid="privacy-summary" className="selectable mt-4 flex flex-col gap-2 rounded-lg bg-surface p-4 text-body">
        {PRIVACY_SUMMARY.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </section>
      {PRIVACY_URL && (
        <Group className="mt-4">
          <NavRow
            label="View online"
            value={<ExternalLink size={16} aria-hidden />}
            onClick={() => (net.online ? void openExternal(PRIVACY_URL) : toast.show({ message: 'You’re offline. Connect to open this link.' }))}
          />
        </Group>
      )}
      <article className="selectable mt-6 flex max-w-[65ch] flex-col gap-5">
        {PRIVACY_SECTIONS.map((s) => (
          <section key={s.heading} className="flex flex-col gap-2">
            <h2 className="text-h3 font-semibold">{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p} className="text-body text-fg-muted">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="list-disc pl-5 text-body text-fg-muted">
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </article>
    </Page>
  );
}
