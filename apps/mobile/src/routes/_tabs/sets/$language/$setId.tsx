import { Link, createFileRoute } from '@tanstack/react-router';
import { CheckCircle2, MoreHorizontal, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { z } from 'zod';
import { AddConfirmSheet } from '../../../../components/add-confirm';
import { CardTile } from '../../../../components/card';
import { BottomSheet, useToast } from '../../../../components/overlay';
import { Page } from '../../../../components/page';
import { RefreshSetRow } from '../../../../components/refresh-set';
import { SetLogo } from '../../../../components/set-logo';
import { Banner, Button, EmptyState, ErrorState, SegmentedControl, Skeleton } from '../../../../components/ui';
import { useSet, useSetCards, useSettings, useUpdateSettings } from '../../../../data';
import { describeError } from '../../../../lib/errors';
import { collectorNumber, formatPercent, formatDate, formatInt, plural, LANGUAGE_NAMES, type Language } from '../../../../lib/format';
import { useDelayedFlag, useSentinel } from '../../../../lib/hooks';
import { useSetSearch, useSheetParam } from '../../../../lib/sheets';

export const Route = createFileRoute('/_tabs/sets/$language/$setId')({
  validateSearch: z.object({
    tab: z.enum(['all', 'owned', 'missing', 'dupes']).optional().catch(undefined),
    menu: z.union([z.string(), z.number(), z.boolean()]).optional().catch(undefined),
    add: z.string().optional().catch(undefined)
  }),
  component: SetDetail
});

function Ring({ percent }: { percent: number | null }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative size-16 shrink-0" role="img" aria-label={percent === null ? 'Catalog incomplete' : (percent > 0 && percent < 1 ? 'Less than 1 percent complete' : `${Math.floor(percent)} percent complete`)}>
      <svg viewBox="0 0 64 64" className="size-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ps-surface-3)" strokeWidth="6" />
        {percent !== null && <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ps-accent)" strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - percent / 100)} />}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-small font-bold tabular-nums">{percent === null ? '—' : formatPercent(percent)}</span>
    </div>
  );
}

function SetDetail() {
  const { language: langParam, setId } = Route.useParams();
  const language: Language = langParam === 'ja' ? 'ja' : 'en';
  const search = Route.useSearch();
  const setSearch = useSetSearch();
  const menu = useSheetParam('menu');
  const addSheet = useSheetParam('add');
  const toast = useToast();
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const tab = search.tab ?? 'all';
  const set = useSet({ language, setId });
  const cards = useSetCards({ language, setId, ownership: tab === 'missing' ? 'missing' : tab === 'owned' ? 'owned' : 'all', ...(tab === 'dupes' ? { duplicates: true } : {}) });
  const rows = useMemo(() => cards.data?.pages.flatMap((p) => p.data) ?? [], [cards.data]);
  const sentinel = useSentinel(() => void cards.fetchNextPage(), !!cards.hasNextPage && !cards.isFetchingNextPage);
  const skeleton = useDelayedFlag(set.isPending);
  const s = set.data;
  const following = !!settings.data?.setsFollowed.some((k) => k.language === language && k.setId === setId);

  if (set.isError) {
    return (
      <Page title="Set" back={{ label: 'Sets', to: '/sets' }}>
        <ErrorState error={set.error} onRetry={() => void set.refetch()} />
      </Page>
    );
  }
  if (!s) {
    return (
      <Page title="Set" back={{ label: 'Sets', to: '/sets' }}>
        {skeleton && (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-20 w-60" />
            <Skeleton className="h-7 w-52" />
            <div className="tile-grid">{Array.from({ length: 12 }).map((_, i) => <div key={i} className="shimmer aspect-card rounded-card" />)}</div>
          </div>
        )}
      </Page>
    );
  }

  const collect = async () => {
    const cur = settings.data?.setsFollowed ?? [];
    const next = following ? cur.filter((k) => !(k.language === language && k.setId === setId)) : [...cur, { language, setId }];
    try {
      await updateSettings.mutateAsync(next.length === 0 && following ? { setsFollowed: [], syncAllSets: settings.data?.syncAllSets ?? false } : { setsFollowed: next, syncAllSets: false });
      toast.show({ message: following ? 'Stopped collecting this set' : 'Collecting this set' });
    } catch (e) {
      toast.show({ message: describeError(e).body, tone: 'negative' });
    }
    menu.close();
  };

  const tabs = [
    { value: 'all', label: `All ${formatInt(s.catalogCount)}`, aria: `All ${s.catalogCount} cards` },
    { value: 'owned', label: `Owned ${formatInt(s.ownedUnique)}`, aria: `Owned ${s.ownedUnique}` },
    { value: 'missing', label: `Missing ${formatInt(s.missingCount)}`, aria: `Missing ${s.missingCount}` },
    { value: 'dupes', label: 'Dupes', aria: 'Duplicates' }
  ] as const;

  const addTarget = search.add ? { kind: 'catalog' as const, language, cardId: search.add } : null;

  return (
    <Page
      title={s.name}
      back={{ label: 'Sets', to: '/sets' }}
      actions={
        <button type="button" aria-label="More actions" data-testid="set-menu" onClick={() => menu.open('1')} className="inline-flex size-(--ps-tap) items-center justify-center rounded-full text-chrome-accent">
          <MoreHorizontal size={24} aria-hidden />
        </button>
      }
      sticky={
        <SegmentedControl tabs className="w-full" label="Show" value={tab} onChange={(v) => setSearch({ tab: v === 'all' ? undefined : v })} options={tabs.map((t) => ({ value: t.value, label: <span className="truncate text-caption">{t.label}</span>, aria: t.aria, testId: `tab-${t.value}` }))} />
      }
    >
      <div className="flex flex-col gap-4 pb-3 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex justify-center lg:justify-start"><SetLogo set={s} large /></div>
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-h1 font-bold">{s.name}</h2>
          <p className="text-body text-fg-muted">{[s.series, formatDate(s.releaseDate), LANGUAGE_NAMES[language].slice(0, 2).toUpperCase()].filter(Boolean).join(' · ')}</p>
          <div className="mt-3 flex items-center gap-3">
            <Ring percent={s.completionPercent} />
            <div className="text-small text-fg-muted" data-testid="set-counts">
              <div className="text-body text-fg">{formatInt(s.ownedUnique)} of {plural(s.catalogCount, 'card')}</div>
              <div>{formatInt(s.missingCount)} missing · {plural(s.duplicateExtras, 'duplicate')}</div>
              {s.officialCount ? <div>Official set: {formatInt(s.officialCount)}{s.totalCount && s.totalCount > s.officialCount ? ` + ${formatInt(s.totalCount - s.officialCount)} secret` : ''}</div> : null}
              {s.customOwnedCount > 0 && <div>+ {formatInt(s.customOwnedCount)} custom cards not counted</div>}
            </div>
          </div>
        </div>
      </div>

      {s.completionPercent === null && (
        <div className="mb-3">
          <Banner tone="warning">
            This set isn’t fully downloaded ({formatInt(s.catalogCount)}{s.totalCount ? ` of ${formatInt(s.totalCount)}` : ''} cards). Completion will show once it is. Downloading a single set isn’t available yet.
          </Banner>
        </div>
      )}

      {cards.isError && <ErrorState error={cards.error} onRetry={() => void cards.refetch()} />}
      {cards.isPending && (
        <div className="tile-grid" aria-hidden>{Array.from({ length: 12 }).map((_, i) => <div key={i} className="shimmer aspect-card rounded-card" />)}</div>
      )}
      {cards.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={CheckCircle2}
          title={tab === 'missing' ? 'Set complete' : tab === 'owned' ? 'Nothing owned yet' : tab === 'dupes' ? 'No duplicates' : 'No cards'}
          body={tab === 'missing' ? `You own every card in ${s.name}.` : tab === 'owned' ? 'Add cards from this set to see them here.' : undefined}
        />
      )}
      {rows.length > 0 && (
        <div className="tile-grid" data-testid="set-grid">
          {rows.map((c) => {
            const owned = c.ownedCount > 0;
            return (
              <CardTile
                key={c.id}
                testId="set-card"
                link={{ to: '/cards/$language/$cardId', params: { language, cardId: c.id } }}
                name={c.name}
                image={c.imageUrl}
                meta={{ name: c.name, setName: s.name, localId: c.localId, rarity: c.rarity }}
                metaLine={collectorNumber(c.localId, c.setOfficialCount) ?? ""}
                qty={owned ? c.ownedCount : 1}
                missing={!owned}
                dim={!owned && tab === 'all'}
                ariaLabel={`${c.name}, ${c.localId}${owned ? `, you own ${c.ownedCount}` : ', Missing'}`}
                overlay={
                  !owned ? (
                    <button type="button" aria-label={`Add ${c.name} to collection`} data-testid="missing-add" onClick={() => addSheet.open(c.id)} className="absolute bottom-6 right-0 inline-flex size-(--ps-tap) items-center justify-center rounded-full bg-accent text-on-accent shadow-2">
                      <Plus size={22} aria-hidden />
                    </button>
                  ) : undefined
                }
              />
            );
          })}
        </div>
      )}
      {cards.hasNextPage && (
        <div ref={sentinel} className="flex justify-center py-6">
          <Button variant="secondary" loading={cards.isFetchingNextPage} onClick={() => void cards.fetchNextPage()}>Load more</Button>
        </div>
      )}

      <AddConfirmSheet target={addTarget} onClose={addSheet.close} />
      <BottomSheet open={(search as { menu?: unknown }).menu !== undefined} title="Set actions" leading="Close" onClose={menu.close} testId="set-menu-sheet">
        <div className="overflow-hidden rounded-lg bg-surface">
          <Link to="/add" search={{ set: `${language}:${setId}` } as never} className="flex min-h-(--ps-tap-lg) items-center px-4 text-body active:bg-surface-3">Add cards from this set</Link>
          <button type="button" disabled={updateSettings.isPending} onClick={() => void collect()} className="flex min-h-(--ps-tap-lg) w-full items-center border-t border-border px-4 text-left text-body active:bg-surface-3">{following ? 'Stop collecting' : 'Collect this set'}</button>
          <RefreshSetRow language={language} setId={setId} className="border-t border-border" onDone={menu.close} />
        </div>
      </BottomSheet>
    </Page>
  );
}
