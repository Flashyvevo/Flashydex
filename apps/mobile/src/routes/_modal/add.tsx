import { Link, createFileRoute } from '@tanstack/react-router';
import { DatabaseZap, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { AddConfirmSheet, type AddTarget } from '../../components/add-confirm';
import { CardRow, LangBadge, RarityLabel } from '../../components/card';
import { ModalPage, useCloseOrBack } from '../../components/page';
import { Banner, EmptyState, ErrorState, LinkButton, NativeSelect, SearchField, SegmentedControl, Skeleton } from '../../components/ui';
import { useCardSearch, useCatalogCard, useCatalogInstall, useCatalogStatus, useCollection, useSetCards, useSets } from '../../data';
import { collectorNumber, formatInt, type Language } from '../../lib/format';
import { useDebounced, useDelayedFlag } from '../../lib/hooks';
import { prefs, type SearchLanguage } from '../../lib/prefs';
import { useSheetParam, useSetSearch } from '../../lib/sheets';

export const Route = createFileRoute('/_modal/add')({
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
    lang: z.enum(['all', 'en', 'ja']).optional().catch(undefined),
    set: z.string().optional().catch(undefined),
    card: z.string().optional().catch(undefined)
  }),
  component: AddPage
});

type Attempt = { query: { q?: string; localId?: string; language?: Language; setId?: string; match?: 'prefix' | 'contains'; limit: number }; broader?: boolean };

const ID_PATTERN = /^[A-Za-z0-9.+]+-[A-Za-z0-9%]+$/;

/** Query parsing per UX §7.1 → ordered attempts; each later attempt only runs if the earlier ones were empty. */
export function buildAttempts(text: string, language: Language | undefined, setId: string | undefined): { attempts: Attempt[]; directId: string | null } {
  const t = text.trim();
  const base = { ...(language ? { language } : {}), ...(setId ? { setId } : {}), limit: 30 };
  if (!t) return { attempts: [], directId: null };
  if (ID_PATTERN.test(t) && /[a-zA-Z]/.test(t.split('-')[0] ?? '')) return { attempts: [], directId: t };
  const numberOnly = /^(\d+[A-Za-z]?)(?:\/(\d+))?$/.exec(t);
  if (numberOnly) {
    const id = numberOnly[1]!;
    const attempts: Attempt[] = [{ query: { ...base, localId: id } }];
    if (/^\d+$/.test(id) && id.length < 3) attempts.push({ query: { ...base, localId: id.padStart(3, '0') } });
    return { attempts, directId: null };
  }
  const named = /^(.*\S)\s+(\d+[A-Za-z]?)(?:\/\d+)?$/.exec(t);
  if (named) {
    return {
      attempts: [
        { query: { ...base, q: named[1]!, localId: named[2]!, match: 'prefix' } },
        { query: { ...base, q: named[1]!, match: 'prefix' } },
        { query: { ...base, q: named[1]!, match: 'contains' }, broader: true }
      ],
      directId: null
    };
  }
  return { attempts: [{ query: { ...base, q: t, match: 'prefix' } }, { query: { ...base, q: t, match: 'contains' }, broader: true }], directId: null };
}

function useAddSearch(text: string, language: Language | undefined, setId: string | undefined) {
  const { attempts, directId } = useMemo(() => buildAttempts(text, language, setId), [text, language, setId]);
  const s1 = useCardSearch(attempts[0]?.query);
  const first = s1.isSuccess && !s1.isPlaceholderData ? s1.data.data.length : null;
  const s2 = useCardSearch(attempts[1] && first === 0 ? attempts[1].query : undefined);
  const second = s2.isSuccess && !s2.isPlaceholderData ? s2.data.data.length : null;
  const s3 = useCardSearch(attempts[2] && first === 0 && second === 0 ? attempts[2].query : undefined);
  const [idLang, idCard] = directId ? [language ?? 'en', directId] : [undefined, undefined];
  const d1 = useCatalogCard(idLang && idCard ? { language: idLang, cardId: idCard } : undefined);
  const other: Language = idLang === 'en' ? 'ja' : 'en';
  const d2 = useCatalogCard(idCard && !language && d1.isError ? { language: other, cardId: idCard } : undefined);

  if (directId) {
    const hit = d1.data ?? d2.data;
    return { rows: hit ? [hit] : [], broader: false, pending: d1.isPending && !d1.isError ? true : d1.isError && !language ? d2.isPending && !d2.isError : false, error: null as unknown, stale: false };
  }
  const chain = [s1, s2, s3];
  let used = 0;
  let pending = false;
  for (let i = 0; i < attempts.length; i++) {
    const s = chain[i]!;
    if (s.isError) return { rows: [], broader: false, pending: false, error: s.error as unknown, stale: false };
    if (!s.isSuccess || s.isPlaceholderData) {
      pending = true;
      used = i;
      break;
    }
    used = i;
    if (s.data.data.length > 0) break;
  }
  const cur = chain[used]!;
  return { rows: cur.data?.data ?? [], broader: !!attempts[used]?.broader && (cur.data?.data.length ?? 0) > 0, pending, error: null as unknown, stale: !!cur.isPlaceholderData };
}

function AddPage() {
  const search = Route.useSearch();
  const setSearch = useSetSearch();
  const close = useCloseOrBack('/');
  const cardSheet = useSheetParam('card');
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(search.q ?? '');
  const debounced = useDebounced(text, 200);
  const lang: SearchLanguage = search.lang ?? prefs.searchLanguage();
  const language = lang === 'all' ? undefined : lang;
  const setScope = search.set;
  const [scopeLang, scopeId] = setScope?.includes(':') ? (setScope.split(':') as [Language, string]) : [undefined, undefined];

  useEffect(() => {
    if ((search.q ?? '') !== debounced.trim()) setSearch({ q: debounced.trim() || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // Stale-result guard: results are only shown for the debounced query that produced them.
  const settled = debounced.trim() === text.trim();
  const result = useAddSearch(debounced, scopeLang ?? language, scopeId);
  const showSkeleton = useDelayedFlag(result.pending || !settled);

  const en = useCatalogStatus('en');
  const ja = useCatalogStatus('ja');
  const install = useCatalogInstall();
  const anyInstalled = en.data?.installed.status === 'installed' || ja.data?.installed.status === 'installed';
  const known = en.isSuccess && ja.isSuccess;

  const recent = useCollection({ groupBy: 'copy', sort: 'created_desc', limit: 8 });
  const scopeCards = useSetCards(!debounced.trim() && scopeLang && scopeId ? { language: scopeLang, setId: scopeId, ownership: 'all' } : undefined);
  const sets = useSets({ owned: false, limit: 50, sort: 'name_asc', hideTcgPocket: false, ...(language ? { language } : {}) });

  useEffect(() => {
    const onAnother = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('fd:add-another', onAnother);
    return () => window.removeEventListener('fd:add-another', onAnother);
  }, []);

  const cardParam = search.card;
  const target: AddTarget | null = useMemo(() => {
    if (!cardParam) return null;
    if (cardParam.startsWith('custom:')) return { kind: 'custom', id: cardParam.slice(7) };
    const [l, ...rest] = cardParam.split(':');
    return (l === 'en' || l === 'ja') && rest.length ? { kind: 'catalog', language: l, cardId: rest.join(':') } : null;
  }, [cardParam]);

  const openCard = (l: Language, id: string) => cardSheet.open(`${l}:${id}`);

  const rows = result.rows;
  const hasQuery = debounced.trim().length > 0;

  return (
    <ModalPage title="Add a card" onClose={close} noFooterPad>
      <div className="sticky z-(--ps-z-sticky) -mx-4 flex flex-col gap-2 bg-bg px-4 pb-2" style={{ top: 'var(--ps-topbar-total)' }}>
        <SearchField value={text} onChange={setText} placeholder="Search name, number or id" label="Search the catalog" autoFocus inputRef={inputRef} onEnter={() => rows[0] && openCard(rows[0].language, rows[0].id)} />
        <div className="flex flex-col gap-2">
          <SegmentedControl
            label="Language"
            value={lang}
            onChange={(v) => {
              prefs.setSearchLanguage(v);
              setSearch({ lang: v });
            }}
            className="flex w-full"
            options={[
              { value: 'all', label: 'All', aria: 'All languages', testId: 'lang-all' },
              { value: 'en', label: 'EN', aria: 'English', testId: 'lang-en' },
              { value: 'ja', label: 'JA', aria: 'Japanese', testId: 'lang-ja' }
            ]}
          />
          <NativeSelect
            label="In"
            value={setScope ?? ''}
            onChange={(v) => setSearch({ set: v || undefined })}
            testId="add-set-scope"
            options={[{ value: '', label: 'Any set' }, ...(setScope && !sets.data?.data.some((s) => `${s.language}:${s.id}` === setScope) ? [{ value: setScope, label: setScope }] : []), ...(sets.data?.data ?? []).map((s) => ({ value: `${s.language}:${s.id}`, label: `${s.name} (${s.language.toUpperCase()})` }))]}
          />
        </div>
      </div>

      {install.active && install.progress && (
        <div className="mb-2">
          <Banner tone="info" testId="add-downloading">
            Downloading the {install.progress.language === 'en' ? 'English' : 'Japanese'} catalog
            {install.progress.compressedBytesTotal ? ` (${Math.round((install.progress.compressedBytesDone / install.progress.compressedBytesTotal) * 100)} %)` : ''}. Search works when it’s done.
          </Banner>
        </div>
      )}

      <div className="pb-24">
        {known && !anyInstalled && !install.active ? (
          <EmptyState
            icon={DatabaseZap}
            title="The card catalog isn’t downloaded yet"
            body="Download it once to search every card. You can still create a custom card."
            action={<LinkButton to="/settings/catalog" variant="primary" full>Choose languages</LinkButton>}
            secondary={<LinkButton to="/custom-cards/new" search={{ name: debounced.trim() || undefined } as never} variant="text">Create a custom card</LinkButton>}
          />
        ) : result.error ? (
          <ErrorState error={result.error} />
        ) : !hasQuery ? (
          <EmptyQuery
            setCards={scopeLang && scopeId ? (scopeCards.data?.pages.flatMap((p) => p.data) ?? []) : null}
            loadingSet={scopeCards.isPending && !!scopeId}
            recent={recent.data?.pages.flatMap((p) => p.data) ?? []}
            onOpen={(l, id) => openCard(l, id)}
            onOpenCustom={(id) => cardSheet.open(`custom:${id}`)}
          />
        ) : rows.length === 0 && !result.pending && settled ? (
          <>
            <EmptyState
              icon={SearchX}
              title={`No cards found for “${debounced.trim()}”`}
              body="Check the spelling, try the collector number (like 136/189), or switch language."
              action={<LinkButton to="/custom-cards/new" search={{ name: debounced.trim() } as never} variant="primary" full>Create a custom card</LinkButton>}
              secondary={language ? <button type="button" className="inline-flex min-h-(--ps-tap) items-center px-3 text-accent-fg" onClick={() => setSearch({ lang: 'all' })}>Search all languages</button> : undefined}
            />
            <p className="px-6 text-center text-caption text-fg-muted">
              Newer sets may not be in your catalog yet. <Link to="/settings/catalog" className="text-accent-fg">Check for updates</Link>
            </p>
          </>
        ) : (
          <div aria-busy={result.pending || !settled}>
            {result.broader && <p className="px-1 pb-1 text-caption text-fg-muted">Broader matches</p>}
            {rows.length === 0 && showSkeleton ? (
              <div className="flex flex-col gap-2" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16" />)}</div>
            ) : (
              <div className="-mx-4 divide-y divide-border overflow-hidden bg-surface lg:mx-0 lg:rounded-lg" data-testid="results" style={{ opacity: settled && !result.stale ? 1 : 0.6 }}>
                {rows.map((c) => (
                  <CardRow
                    key={`${c.language}:${c.id}`}
                    testId="result-row"
                    onClick={() => openCard(c.language, c.id)}
                    name={c.name}
                    image={c.imageUrl}
                    meta={{ name: c.name, setName: c.setName, localId: c.localId, rarity: c.rarity }}
                    line2={[c.setName, collectorNumber(c.localId, c.setOfficialCount)].filter(Boolean).join(' · ')}
                    badges={<LangBadge language={c.language} />}
                    ariaLabel={`${c.name}, ${c.setName ?? ''} ${c.localId}, ${c.language === 'en' ? 'English' : 'Japanese'}${c.ownedCount ? `, you own ${c.ownedCount}` : ''}`}
                    trailing={
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <RarityLabel rarity={c.rarity} />
                        {c.ownedCount > 0 && <span className="text-caption text-accent-fg">You own {formatInt(c.ownedCount)}</span>}
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-bg" style={{ zIndex: 'var(--ps-z-nav)', paddingBottom: 'max(var(--ps-keyboard-inset), var(--ps-safe-bottom))' }}>
        <div className="mx-auto flex min-h-(--ps-tap-lg) max-w-2xl items-center justify-center px-4 text-small text-fg-muted">
          Can’t find it?
          <Link to="/custom-cards/new" search={{ name: debounced.trim() || undefined } as never} data-testid="create-custom-link" className="inline-flex min-h-(--ps-tap) items-center px-2 font-semibold text-accent-fg">
            Create a custom card
          </Link>
        </div>
      </div>

      <AddConfirmSheet
        target={target}
        onClose={cardSheet.close}
        onAddAnother={() => setTimeout(() => window.dispatchEvent(new Event('fd:add-another')), 60)}
      />
    </ModalPage>
  );
}

type SetCardRow = { id: string; language: Language; name: string; setName: string | null; localId: string; setOfficialCount?: number | null; rarity: string | null; imageUrl: string | null; ownedCount: number };
type RecentCopy = { id: string; catalogCardId: string | null; customCardId: string | null; language: Language; name: string; setName: string | null; localId: string | null; setOfficialCount?: number | null; rarity: string | null; imageUrl: string | null };

function EmptyQuery({ setCards, loadingSet, recent, onOpen, onOpenCustom }: { setCards: SetCardRow[] | null; loadingSet: boolean; recent: RecentCopy[]; onOpen: (l: Language, id: string) => void; onOpenCustom: (id: string) => void }) {
  if (setCards || loadingSet) {
    return (
      <div>
        <h2 className="px-1 pb-1 text-caption font-semibold text-fg-muted">Cards in this set</h2>
        {loadingSet ? <Skeleton className="h-16" /> : (
          <div className="-mx-4 divide-y divide-border overflow-hidden bg-surface lg:mx-0 lg:rounded-lg">
            {(setCards ?? []).map((c) => (
              <CardRow key={c.id} testId="result-row" onClick={() => onOpen(c.language, c.id)} name={c.name} image={c.imageUrl} meta={{ name: c.name, setName: c.setName, localId: c.localId, rarity: c.rarity }} line2={collectorNumber(c.localId, c.setOfficialCount) ?? ""} trailing={c.ownedCount > 0 ? <span className="text-caption text-accent-fg">You own {c.ownedCount}</span> : undefined} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (recent.length === 0) {
    return <p className="px-2 py-10 text-center text-body text-fg-muted">Type a card name, a collector number like 136/189, or a card id like swsh3-136.</p>;
  }
  const seen = new Set<string>();
  const unique = recent.filter((c) => {
    const key = c.catalogCardId ? `${c.language}:${c.catalogCardId}` : `custom:${c.customCardId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div>
      <h2 className="px-1 pb-1 text-caption font-semibold text-fg-muted">Recent</h2>
      <div className="-mx-4 divide-y divide-border overflow-hidden bg-surface lg:mx-0 lg:rounded-lg">
        {unique.map((c) => (
          <CardRow
            key={c.id}
            testId="recent-row"
            onClick={() => (c.catalogCardId ? onOpen(c.language, c.catalogCardId) : c.customCardId && onOpenCustom(c.customCardId))}
            name={c.name}
            image={c.imageUrl}
            meta={{ name: c.name, setName: c.setName, localId: c.localId, rarity: c.rarity }}
            line2={[c.setName, collectorNumber(c.localId, c.setOfficialCount)].filter(Boolean).join(' · ')}
            badges={<LangBadge language={c.language} />}
          />
        ))}
      </div>
    </div>
  );
}
