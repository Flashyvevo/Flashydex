import { Link, createFileRoute } from '@tanstack/react-router';
import { Filter, LayoutGrid, List, SearchX, X, ArrowUpDown } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { FilterControls } from '../../../components/filters';
import { GroupRow, GroupTile } from '../../../components/owned';
import { BottomSheet } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { Banner, Button, EmptyState, ErrorState, LinkButton, SearchField, SegmentedControl, Skeleton, cx } from '../../../components/ui';
import { useCatalogStatus, useCollection, useDashboard, useSettings } from '../../../data';
import { collectionSearch, countFilters, pickFilters, SORT_LABEL, SORTS, toQuery, type Filters, type SortKey } from '../../../lib/collection-query';
import { formatInt, plural } from '../../../lib/format';
import { useDebounced, useDelayedFlag, useIsWide, useSentinel } from '../../../lib/hooks';
import { prefs, useCollectionViewPref } from '../../../lib/prefs';
import { useSetSearch, useSheetParam } from '../../../lib/sheets';
import type { Currency } from '../../../data';

export const Route = createFileRoute('/_tabs/collection/')({ validateSearch: collectionSearch, component: CollectionPage });

function CollectionPage() {
  const search = Route.useSearch();
  const setSearch = useSetSearch();
  const wide = useIsWide();
  const sheets = useSheetParam();
  const settings = useSettings();
  const dash = useDashboard();
  const en = useCatalogStatus('en');
  const viewPref = useCollectionViewPref();
  const view = search.view ?? viewPref;
  const [text, setText] = useState(search.q ?? '');
  const debounced = useDebounced(text, 150);

  // Keep the box in sync when the URL changes from outside (back, links).
  useEffect(() => setText(search.q ?? ''), [search.q]);
  useEffect(() => {
    if ((search.q ?? '') !== debounced.trim()) setSearch({ q: debounced.trim() || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const filters = pickFilters(search);
  const query = useMemo(() => toQuery({ ...filters, q: search.q, sort: search.sort }), [filters, search.q, search.sort]);
  const result = useCollection(query);
  const groups = useMemo(() => result.data?.pages.flatMap((p) => p.data) ?? [], [result.data]);
  const total = result.data?.pages[0]?.page.total ?? 0;
  const sentinel = useSentinel(() => void result.fetchNextPage(), !!result.hasNextPage && !result.isFetchingNextPage);
  const showSkeleton = useDelayedFlag(result.isPending);
  const filterCount = countFilters(filters);
  const hasQuery = !!search.q;
  const filtered = filterCount > 0 || hasQuery;
  const currency = (settings.data?.defaultCurrency ?? 'USD') as Currency;
  const showLang = (settings.data?.languages.length ?? 1) > 1;
  const rarities = useMemo(() => [...new Set(groups.map((g) => g.representative.rarity).filter((r): r is string => !!r))].sort(), [groups]);
  const sort: SortKey = search.sort ?? 'created_desc';

  const clearAll = () => setSearch({ q: undefined, set: undefined, rarity: undefined, lang: undefined, cond: undefined, graded: undefined, dupes: undefined, loc: undefined, group: undefined, variant: undefined, priced: undefined, num: undefined });

  const chips = activeChips(filters, (k) => setSearch({ [k]: undefined }));

  const toolbar = (
    <div className="flex flex-col gap-2">
      <SearchField value={text} onChange={setText} placeholder="Search by name or number" label="Search your collection" />
      <div className="flex items-center gap-2">
        {!wide && (
          <Button variant="secondary" className="min-h-(--ps-tap) px-2" icon={Filter} data-testid="filter-button" aria-label={filterCount ? `Filters, ${filterCount} active` : 'Filters'} onClick={() => sheets.open('filters')}>
            Filters{filterCount > 0 && <span className="ml-1 rounded-full bg-accent px-1.5 text-micro text-on-accent">{filterCount}</span>}
          </Button>
        )}
        <Button variant="secondary" className="min-h-(--ps-tap) min-w-0 px-1.5" icon={ArrowUpDown} data-testid="sort-button" onClick={() => sheets.open('sort')}>
          <span className="truncate">{SORT_LABEL[sort]}</span>
        </Button>
        <SegmentedControl
          className="ml-auto"
          label="View"
          value={view}
          onChange={(v) => {
            prefs.setCollectionView(v);
            setSearch({ view: v });
          }}
          options={[
            { value: 'grid', label: <LayoutGrid size={18} aria-hidden />, aria: 'Grid view', testId: 'view-grid' },
            { value: 'list', label: <List size={18} aria-hidden />, aria: 'List view', testId: 'view-list' }
          ]}
        />
      </div>
      {chips.length > 0 && (
        <ul className="scroll-hide -mx-4 flex gap-2 overflow-x-auto px-4" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.key} className="shrink-0">
              <button type="button" onClick={c.clear} aria-label={`Remove filter ${c.label}`} className="inline-flex min-h-(--ps-tap) items-center">
                <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent-soft px-3 text-small text-accent-fg">
                  {c.label}
                  <X size={14} aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <Page title="Collection" large add sticky={toolbar}>
      <div className="lg:grid lg:grid-cols-[260px_1fr] lg:gap-6">
        {wide && (
          <aside aria-label="Filters" className="hidden lg:block">
            <h2 className="mb-3 text-h3 font-semibold">Filters</h2>
            <FilterControls value={filters} rarities={rarities} onChange={(f) => setSearch(allKeysPatch(f))} />
          </aside>
        )}
        <div className="min-w-0">
          <p className="py-2 text-caption text-fg-muted" aria-live="polite" data-testid="result-count">
            {result.isSuccess
              ? filtered
                ? `${formatInt(total)} matching ${total === 1 ? 'card' : 'cards'}`
                : dash.data
                  ? `${plural(dash.data.totalCards, 'card')} · ${formatInt(dash.data.uniqueCards)} unique`
                  : plural(total, 'card')
              : ' '}
          </p>

          {result.isError && (
            <ErrorState error={result.error} onRetry={() => void result.refetch()} />
          )}

          {result.isPending && showSkeleton && (
            <div className={view === 'grid' ? 'tile-grid' : 'flex flex-col gap-2'} aria-hidden>
              {Array.from({ length: view === 'grid' ? 12 : 10 }).map((_, i) =>
                view === 'grid' ? (
                  <div key={i}>
                    <div className="shimmer aspect-card rounded-card" />
                    <Skeleton className="mt-2 h-3 w-3/4" />
                  </div>
                ) : (
                  <Skeleton key={i} className="h-16" />
                )
              )}
            </div>
          )}

          {result.isSuccess && groups.length === 0 && !filtered && (
            <EmptyState
              icon={LayoutGrid}
              title="No cards yet"
              body="Add cards by searching the catalog. They’ll show up here with quantities, conditions and value."
              action={
                <LinkButton to="/add" variant="primary" full>
                  Add a card
                </LinkButton>
              }
              secondary={
                en.data?.installed.status !== 'installed' ? (
                  <LinkButton to="/settings/data" variant="text">
                    Import a collection
                  </LinkButton>
                ) : undefined
              }
            />
          )}

          {result.isSuccess && groups.length === 0 && filtered && (
            <EmptyState
              icon={SearchX}
              title="No cards match"
              body={`Nothing in your collection matches${hasQuery ? ` “${search.q}”` : ''}${filterCount ? ` with ${plural(filterCount, 'filter')}` : ''}.`}
              action={
                <Button variant="primary" full onClick={clearAll}>
                  Clear filters
                </Button>
              }
              secondary={
                hasQuery ? (
                  <Link to="/add" search={{ q: search.q } as never} className="inline-flex min-h-(--ps-tap) items-center px-3 text-accent-fg">
                    Search the whole catalog
                  </Link>
                ) : undefined
              }
            />
          )}

          {groups.length > 0 && view === 'grid' && (
            <div className="tile-grid" data-testid="collection-grid">
              {groups.map((g) => (
                <GroupTile key={`${g.source}:${g.language}:${g.cardId}:${g.variant}`} group={g} currency={currency} showLang={showLang} />
              ))}
            </div>
          )}
          {groups.length > 0 && view === 'list' && (
            <div className="-mx-4 divide-y divide-border overflow-hidden bg-surface lg:mx-0 lg:rounded-lg" data-testid="collection-list">
              {groups.map((g) => (
                <GroupRow key={`${g.source}:${g.language}:${g.cardId}:${g.variant}`} group={g} currency={currency} showLang={showLang} />
              ))}
            </div>
          )}

          {result.hasNextPage && (
            <div ref={sentinel} className="flex justify-center py-6">
              <Button variant="secondary" loading={result.isFetchingNextPage} onClick={() => void result.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
          {result.isFetchNextPageError && (
            <Banner tone="negative" action={<Button variant="text" onClick={() => void result.fetchNextPage()}>Try again</Button>}>
              Couldn’t load more cards.
            </Banner>
          )}
        </div>
      </div>

      <SortSheet open={search.sheet === 'sort'} value={sort} onClose={sheets.close} onPick={(s) => setSearch({ sort: s === 'created_desc' ? undefined : s, sheet: undefined })} />
      <FilterSheet open={search.sheet === 'filters' && !wide} filters={filters} rarities={rarities} q={search.q} sort={search.sort} onClose={sheets.close} />
    </Page>
  );
}

function allKeysPatch(f: Filters): Record<string, unknown> {
  const keys = ['set', 'rarity', 'lang', 'cond', 'graded', 'dupes', 'loc', 'group', 'variant', 'priced', 'num'] as const;
  return Object.fromEntries(keys.map((k) => [k, f[k]]));
}

function activeChips(f: Filters, clear: (k: string) => void) {
  const out: { key: string; label: string; clear: () => void }[] = [];
  const add = (key: string, label: string | undefined) => label && out.push({ key, label, clear: () => clear(key) });
  add('set', f.set ? `Set ${f.set}` : undefined);
  add('rarity', f.rarity);
  add('lang', f.lang?.toUpperCase());
  add('cond', f.cond ? (f.cond === 'unknown' || f.cond === '?' ? 'Condition not recorded' : f.cond) : undefined);
  add('graded', f.graded === 'graded' ? 'Graded' : f.graded === 'raw' ? 'Raw' : undefined);
  add('dupes', f.dupes ? 'Duplicates' : undefined);
  add('loc', f.loc ? (f.loc === 'none' ? 'No location' : 'Location') : undefined);
  add('group', f.group ? 'Group' : undefined);
  add('variant', f.variant ? f.variant.replace('_', ' ') : undefined);
  add('priced', f.priced === 'none' ? 'No price' : f.priced === 'some' ? 'Has price' : undefined);
  add('num', f.num ? `#${f.num}` : undefined);
  return out;
}

function SortSheet({ open, value, onClose, onPick }: { open: boolean; value: SortKey; onClose: () => void; onPick: (s: SortKey) => void }) {
  return (
    <BottomSheet open={open} title="Sort" leading="Close" onClose={onClose} testId="sort-sheet">
      <div role="radiogroup" aria-label="Sort by" className="overflow-hidden rounded-lg bg-surface">
        {SORTS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={s === value}
            data-testid={`sort-${s}`}
            onClick={() => onPick(s)}
            className="flex min-h-(--ps-tap-lg) w-full items-center justify-between px-4 text-left text-body active:bg-surface-3"
          >
            {SORT_LABEL[s]}
            {s === value && <span aria-hidden className="text-accent-fg">✓</span>}
          </button>
        ))}
      </div>
      <p className="px-1 pt-2 text-caption text-fg-muted">Cards without a price are listed last.</p>
    </BottomSheet>
  );
}

function FilterSheet({ open, filters, rarities, q, sort, onClose }: { open: boolean; filters: Filters; rarities: string[]; q?: string; sort?: SortKey; onClose: () => void }) {
  const setSearch = useSetSearch();
  const [staged, setStaged] = useState<Filters>(filters);
  useEffect(() => {
    if (open) setStaged(filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const debounced = useDebounced(staged, 150);
  const count = useCollection({ ...toQuery({ ...debounced, q, sort }), limit: 1 });
  const total = count.data?.pages[0]?.page.total;
  if (!open) return null;
  return (
    <BottomSheet
      open
      large
      title="Filters"
      leading="Cancel"
      onClose={onClose}
      testId="filter-sheet"
      trailing={
        <button type="button" onClick={() => setStaged({})} className="inline-flex min-h-(--ps-tap) min-w-(--ps-tap) items-center justify-center px-3 text-body text-accent-fg">
          Reset
        </button>
      }
      footer={
        <Button
          variant="primary"
          full
          data-testid="filter-apply"
          onClick={() => {
            setSearch({ ...Object.fromEntries(['set', 'rarity', 'lang', 'cond', 'graded', 'dupes', 'loc', 'group', 'variant', 'priced', 'num'].map((k) => [k, (staged as Record<string, unknown>)[k]])), sheet: undefined });
          }}
        >
          {total === undefined ? 'Show cards' : `Show ${plural(total, 'card')}`}
        </Button>
      }
    >
      <div className={cx('pt-1')}>
        <FilterControls value={staged} rarities={rarities} onChange={setStaged} />
      </div>
    </BottomSheet>
  );
}
