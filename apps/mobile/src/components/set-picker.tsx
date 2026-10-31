import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSetIndex } from '../data';
import { assetWebp, plural, releaseYear, type Language } from '../lib/format';
import { ChipGroup, SearchField, Skeleton, cx } from './ui';

export type SetKey = { language: Language; setId: string };
export const setKeyString = (k: SetKey): string => `${k.language}:${k.setId}`;

type IndexEntry = {
  language: Language;
  id: string;
  name: string;
  series: string | null;
  releaseDate: string | null;
  totalCount: number | null;
  officialCount: number | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  status: string;
};

/** "Sets you collect" picker (UX §15.6 / §10.2). Data: useSetIndex(language) (installed → manifest → bundled). */
export function SetPicker({
  languages,
  selected,
  onToggle,
  hideTcgPocket
}: {
  languages: Language[];
  selected: Set<string>;
  onToggle: (k: SetKey) => void;
  hideTcgPocket: boolean;
}) {
  const [lang, setLang] = useState<Language>(languages[0] ?? 'en');
  const [q, setQ] = useState('');
  const active = languages.includes(lang) ? lang : (languages[0] ?? 'en');
  const index = useSetIndex(active);
  const sets = useMemo(() => {
    const all = ((index.data?.rows ?? []) as IndexEntry[]).filter((s) => s.status !== 'unpublished' && !(hideTcgPocket && s.series === 'tcgp'));
    const needle = q.trim().toLowerCase();
    const filtered = needle ? all.filter((s) => s.name.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle)) : all;
    return [...filtered].sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.id.localeCompare(b.id));
  }, [index.data, q, hideTcgPocket]);

  const groups = useMemo(() => {
    const m = new Map<string, IndexEntry[]>();
    for (const s of sets) {
      const key = s.series ?? 'Other';
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return [...m.entries()];
  }, [sets]);

  return (
    <div className="flex flex-col gap-3" data-testid="set-picker">
      <SearchField value={q} onChange={setQ} label="Search sets" placeholder="Search sets" testId="set-search" />
      {languages.length > 1 && (
        <ChipGroup label="Language" hideLabel value={active} onChange={setLang} options={languages.map((l) => ({ value: l, label: l.toUpperCase() }))} />
      )}
      {index.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : sets.length === 0 ? (
        <p className="py-6 text-center text-small text-fg-muted">{q ? 'No sets match.' : 'No set list is available offline yet. You can pick sets later in Settings.'}</p>
      ) : (
        <div className="overflow-hidden rounded-lg bg-surface">
          {groups.map(([series, list]) => (
            <section key={series} aria-label={series}>
              <h3 className="sticky top-0 z-(--ps-z-sticky) bg-surface-2 px-4 py-1.5 text-micro uppercase tracking-wide text-fg-muted">{series}</h3>
              <ul className="divide-y divide-border">
                {list.map((s) => {
                  const key = { language: s.language, setId: s.id };
                  const on = selected.has(setKeyString(key));
                  const logo = assetWebp(s.logoUrl);
                  return (
                    <li key={s.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '0 56px' }}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        data-testid="set-pick-row"
                        onClick={() => onToggle(key)}
                        className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-3"
                      >
                        <span aria-hidden className={cx('inline-flex size-6 shrink-0 items-center justify-center rounded-md border', on ? 'border-accent bg-accent text-on-accent' : 'border-border-input')}>
                          {on && <Check size={16} />}
                        </span>
                        <span aria-hidden className="flex h-8 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-surface-3">
                          {logo ? <img src={logo} alt="" loading="lazy" className="max-h-full max-w-full object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} /> : <span className="font-mono text-micro text-fg-muted">{s.id}</span>}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body">{s.name}</span>
                          <span className="block text-caption text-fg-muted">
                            {[releaseYear(s.releaseDate), s.totalCount ? plural(s.totalCount, 'card') : null].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
