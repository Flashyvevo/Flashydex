import { Link, createFileRoute } from '@tanstack/react-router';
import { CheckCircle2, Layers } from 'lucide-react';
import { useMemo } from 'react';
import { z } from 'zod';
import { LangBadge } from '../../../components/card';
import { SetLogo } from '../../../components/set-logo';
import { Page } from '../../../components/page';
import { Banner, ChipGroup, EmptyState, ErrorState, LinkButton, SegmentedControl, Skeleton } from '../../../components/ui';
import { useCatalogStatus, useSets, useSettings, type SetSummary } from '../../../data';
import { formatInt, formatPercent, LANGUAGE_NAMES, type Language } from '../../../lib/format';
import { useDelayedFlag } from '../../../lib/hooks';
import { useSetSearch } from '../../../lib/sheets';

export const Route = createFileRoute('/_tabs/sets/')({
  validateSearch: z.object({
    lang: z.enum(['en', 'ja']).optional().catch(undefined),
    show: z.enum(['collecting', 'all']).optional().catch(undefined),
    sort: z.enum(['release_desc', 'name_asc', 'completion_desc']).optional().catch(undefined)
  }),
  component: SetsPage
});

const SORT_OPTIONS = [
  { value: 'release_desc', label: 'Newest' },
  { value: 'name_asc', label: 'Name' },
  { value: 'completion_desc', label: 'Most complete' }
] as const;


function SetsPage() {
  const search = Route.useSearch();
  const setSearch = useSetSearch();
  const settings = useSettings();
  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const installed: Language[] = [en.data?.installed.status === 'installed' ? 'en' : null, ja.data?.installed.status === 'installed' ? 'ja' : null].filter((x): x is Language => !!x);
  const show = search.show ?? 'collecting';
  const sort = search.sort ?? 'release_desc';
  const hideTcgPocket = settings.data?.hideTcgPocket ?? true;
  const query = useMemo(() => ({ ...(search.lang ? { language: search.lang } : {}), ...(show === 'collecting' ? { owned: true } : {}), hideTcgPocket, sort, limit: 50 }), [search.lang, show, hideTcgPocket, sort]);
  const sets = useSets(query);
  const followed = useMemo(() => settings.data?.setsFollowed ?? [], [settings.data?.setsFollowed]);
  // "Collecting" also lists the sets the user chose to collect, even with 0 owned (UX §6.1).
  const all = useSets(show === 'collecting' && followed.length > 0 ? { ...(search.lang ? { language: search.lang } : {}), hideTcgPocket, sort, limit: 50 } : undefined);
  const rows = useMemo(() => {
    const base = sets.data?.data ?? [];
    if (show !== 'collecting' || !all.data) return base;
    const have = new Set(base.map((s) => `${s.language}:${s.id}`));
    const extra = all.data.data.filter((s) => followed.some((f) => f.language === s.language && f.setId === s.id) && !have.has(`${s.language}:${s.id}`));
    return [...base, ...extra];
  }, [sets.data, all.data, followed, show]);
  const skeleton = useDelayedFlag(sets.isPending);
  const missingLangs = (['en', 'ja'] as Language[]).filter((l) => (!search.lang || search.lang === l) && (settings.data?.languages ?? []).includes(l) && !installed.includes(l) && en.isSuccess && ja.isSuccess);
  const noCatalog = en.isSuccess && ja.isSuccess && installed.length === 0;

  return (
    <Page title="Sets" large>
      <div className="flex flex-wrap items-center justify-between gap-2 py-1">
        <ChipGroup label="Language" hideLabel value={search.lang ?? 'all'} onChange={(v) => setSearch({ lang: v === 'all' ? undefined : v })} options={[{ value: 'all', label: 'All' }, { value: 'en', label: 'EN' }, { value: 'ja', label: 'JP' }]} />
        <SegmentedControl label="Show" value={show} onChange={(v) => setSearch({ show: v === 'collecting' ? undefined : v })} options={[{ value: 'collecting', label: 'Collecting', aria: 'Collecting', testId: 'show-collecting' }, { value: 'all', label: 'All', aria: 'All sets', testId: 'show-all' }]} />
      </div>
      <div className="flex flex-wrap gap-1 pb-2">
        <ChipGroup label="Sort" value={sort} onChange={(v) => setSearch({ sort: v === 'release_desc' ? undefined : v })} options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      </div>

      {missingLangs.map((l) => (
        <div key={l} className="mb-2">
          <Banner tone="info" action={<LinkButton to="/settings/catalog" variant="text">Download</LinkButton>}>
            {LANGUAGE_NAMES[l]} catalog not downloaded
          </Banner>
        </div>
      ))}

      {sets.isError && <ErrorState error={sets.error} title="Couldn’t load your sets" body="Your data hasn’t changed." onRetry={() => void sets.refetch()} />}
      {sets.isPending && skeleton && (
        <div className="flex flex-col gap-2" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      )}
      {noCatalog && (
        <EmptyState icon={Layers} title="No sets yet" body="Download the card catalog to browse sets and track completion." action={<LinkButton to="/settings/catalog" variant="primary" full>Choose languages</LinkButton>} />
      )}
      {!noCatalog && sets.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={Layers}
          title={show === 'collecting' ? 'No sets yet' : 'No sets found'}
          body={show === 'collecting' ? 'Sets show up here once you own a card from them or choose them as sets you collect.' : 'Nothing matches this language.'}
          action={show === 'collecting' ? <LinkButton to="/sets" search={{ show: 'all' } as never} variant="primary" full>Show all sets</LinkButton> : undefined}
        />
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface" data-testid="set-list">
          {rows.map((s) => (
            <li key={`${s.language}:${s.id}`}>
              <SetRow set={s} />
            </li>
          ))}
        </ul>
      )}
      {hideTcgPocket && (
        <p className="py-3 text-center text-caption text-fg-muted">
          TCG Pocket sets hidden · <Link to="/settings" className="inline-flex min-h-(--ps-tap) items-center text-accent-fg">Show</Link>
        </p>
      )}
    </Page>
  );
}

function SetRow({ set: s }: { set: SetSummary }) {
  const complete = s.completionPercent !== null && s.completionPercent >= 100;
  const incomplete = s.completionPercent === null;
  return (
    <Link to="/sets/$language/$setId" params={{ language: s.language, setId: s.id }} data-testid="set-row" className="flex min-h-18 items-center gap-3 px-4 py-3 active:bg-surface-3">
      <SetLogo set={s} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-body font-medium">{s.name}</span>
          <LangBadge language={s.language} />
        </span>
        <span className={`flex items-center gap-1 text-caption tabular-nums ${incomplete ? 'text-warning' : 'text-fg-muted'}`}>
          {incomplete ? (
            `${formatInt(s.ownedUnique)} / ${formatInt(s.catalogCount)} loaded · Catalog incomplete`
          ) : (
            <>
              {formatInt(s.ownedUnique)} / {formatInt(s.catalogCount)} · {formatPercent(s.completionPercent)}
              {complete && <CheckCircle2 size={14} className="text-positive" aria-label="Complete" />}
              {s.duplicateExtras > 0 && <span> · {s.duplicateExtras} extra {s.duplicateExtras === 1 ? 'copy' : 'copies'}</span>}
            </>
          )}
        </span>
        {!incomplete && (
          <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, s.completionPercent ?? 0)}%` }} />
          </span>
        )}
      </span>
    </Link>
  );
}
