import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { SetIndex, type CardDetail, type CardSearchQuery, type CardSummary, type DomainError, type Input, type Language, type Page, type SetCardsQuery, type SetIndexRow, type SetKey, type SetListQuery, type SetSummary } from '@flashydex/core';
import { fetchManifestText } from '../platform/pack-install';
import bundledEn from './bootstrap/set-index-en.json';
import bundledJa from './bootstrap/set-index-ja.json';
import { useServicesIfReady } from './context';
import { keys } from './keys';

/** Debounce is the UI's job (200 ms); a changed query key cancels/ignores the stale result. */
export function useCardSearch(query: Input<typeof CardSearchQuery> | undefined) {
  const services = useServicesIfReady();
  return useQuery<Page<CardSummary>, DomainError>({
    queryKey: keys.search(query),
    enabled: services !== null && query !== undefined,
    placeholderData: keepPreviousData,
    queryFn: () => (services as NonNullable<typeof services>).catalog.searchCards(query as Input<typeof CardSearchQuery>)
  });
}

/** Catalog card + latest prices + a page (<=50) of owned copies. `copiesOffset` pages the copies. */
export function useCatalogCard(input: { language: Language; cardId: string; copiesOffset?: number } | undefined) {
  const services = useServicesIfReady();
  return useQuery<CardDetail, DomainError>({
    queryKey: keys.card(input),
    enabled: services !== null && input !== undefined,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const { language, cardId, copiesOffset } = input as NonNullable<typeof input>;
      return (services as NonNullable<typeof services>).catalog.getCard({ language, cardId, offset: copiesOffset ?? 0 });
    }
  });
}

export function useSets(query?: Input<typeof SetListQuery>) {
  const services = useServicesIfReady();
  return useQuery<Page<SetSummary>, DomainError>({ queryKey: keys.sets(query), enabled: services !== null, placeholderData: keepPreviousData, queryFn: () => (services as NonNullable<typeof services>).catalog.listSets(query ?? {}) });
}

export function useSet(key: Input<typeof SetKey> | undefined) {
  const services = useServicesIfReady();
  return useQuery<SetSummary & { missingPreview: CardSummary[] }, DomainError>({
    queryKey: keys.set(key),
    enabled: services !== null && key !== undefined,
    queryFn: () => (services as NonNullable<typeof services>).catalog.getSet(key as Input<typeof SetKey>)
  });
}

/** Infinite list of one set's cards. `ownership: 'all'|'owned'|'missing'`, `duplicates: true` for the duplicates tab. */
export function useSetCards(query: Omit<Input<typeof SetCardsQuery>, 'offset'> | undefined) {
  const services = useServicesIfReady();
  return useInfiniteQuery<Page<CardSummary>, DomainError, InfiniteData<Page<CardSummary>>, ReturnType<typeof keys.setCards>, number>({
    queryKey: keys.setCards(query),
    enabled: services !== null && query !== undefined,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => (services as NonNullable<typeof services>).catalog.listSetCards({ ...(query as NonNullable<typeof query>), offset: pageParam }),
    getNextPageParam: (last) => (last.page.hasMore ? last.page.offset + last.data.length : undefined)
  });
}

export type SetIndexResult = { source: 'catalog' | 'manifest' | 'bundled'; rows: SetIndexRow[] };

const BUNDLED: Record<Language, unknown> = { en: bundledEn, ja: bundledJa };

/**
 * Set index for the first-run picker. Order: installed catalog sets -> manifest `setIndexUrl` -> bundled JSON
 * (`src/data/bootstrap/set-index-<lang>.json`). Never empty-with-fake-rows: the bundled index is real TCGdex data.
 */
export function useSetIndex(language: Language) {
  const services = useServicesIfReady();
  return useQuery<SetIndexResult, DomainError>({
    queryKey: keys.setIndex(language),
    enabled: services !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const s = services as NonNullable<typeof services>;
      try {
        const rows: SetIndexRow[] = [];
        for (let offset = 0; ; offset += 50) {
          const page = await s.catalog.listSets({ language, status: 'all', hideTcgPocket: false, limit: 50, offset });
          rows.push(...page.data.map((r): SetIndexRow => ({ language: r.language, id: r.id, name: r.name, series: r.series, releaseDate: r.releaseDate, totalCount: r.totalCount, officialCount: r.officialCount, logoUrl: r.logoUrl, symbolUrl: r.symbolUrl, status: r.status })));
          if (!page.page.hasMore) break;
        }
        if (rows.length > 0) return { source: 'catalog', rows };
      } catch { /* fall through to the manifest index */ }
      try {
        const check = await s.install.checkManifest({ languages: [language] });
        const url = check.languages.find((l) => l.language === language)?.setIndexUrl;
        if (url) {
          // Origin trust of setIndexUrl was validated by core; the read here is bounded (R09) and never allocates past the cap.
          const body = await fetchManifestText({ maxBytes: 8 * 1024 * 1024, url });
          {
            const parsed = SetIndex.safeParse(JSON.parse(body.text));
            if (parsed.success && parsed.data.length > 0) return { source: 'manifest', rows: parsed.data };
          }
        }
      } catch { /* offline or no manifest: use the bundled index */ }
      const bundled = SetIndex.parse(BUNDLED[language]);
      return { source: 'bundled', rows: bundled };
    }
  });
}
