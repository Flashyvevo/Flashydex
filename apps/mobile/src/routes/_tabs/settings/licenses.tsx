import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Page } from '../../../components/page';
import { SearchField, cx } from '../../../components/ui';
import { ISC_TEXT, LICENSES, MIT_TEXT } from '../../../lib/legal';
import { openExternal } from '../../../lib/native';

export const Route = createFileRoute('/_tabs/settings/licenses')({ component: LicensesPage });

function licenseBody(l: (typeof LICENSES)[number]): string | null {
  if (l.license === 'MIT') return `MIT License\n\nCopyright (c) ${l.holder}\n\n${MIT_TEXT}`;
  if (l.license === 'ISC') return `ISC License\n\nCopyright (c) ${l.holder}\n\n${ISC_TEXT}`;
  return null;
}

function LicensesPage() {
  const [q, setQ] = useState('');
  const list = useMemo(() => LICENSES.filter((l) => l.name.toLowerCase().includes(q.trim().toLowerCase())), [q]);
  return (
    <Page title="Licenses" large back={{ label: 'Settings', to: '/settings' }}>
      <div className="mb-3">
        <SearchField value={q} onChange={setQ} label="Search licenses" placeholder="Search licenses" testId="licenses-search" />
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface" data-testid="license-list">
        {list.map((l) => {
          const body = licenseBody(l);
          return (
            <li key={l.name}>
              <details className="group">
                <summary className="flex min-h-(--ps-tap-lg) cursor-pointer list-none items-center justify-between gap-3 px-4 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-body">{l.name}</span>
                    <span className="block text-caption text-fg-muted">
                      {l.version ? `${l.version} · ` : ''}
                      {l.license}
                    </span>
                  </span>
                  <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className={cx('selectable flex flex-col gap-2 px-4 pb-4 text-caption text-fg-muted')}>
                  {l.note && <p>{l.note}</p>}
                  {body ? (
                    <pre className="whitespace-pre-wrap break-words font-mono text-micro font-normal">{body}</pre>
                  ) : (
                    <p>
                      {l.license}. Copyright © {l.holder}.
                    </p>
                  )}
                  {l.url && (
                    <button type="button" onClick={() => void openExternal(l.url!)} className="inline-flex min-h-(--ps-tap) items-center self-start text-accent-fg">
                      Read the full license ↗
                    </button>
                  )}
                </div>
              </details>
            </li>
          );
        })}
        {list.length === 0 && <li className="px-4 py-6 text-center text-small text-fg-muted">No matching licenses.</li>}
      </ul>
    </Page>
  );
}
