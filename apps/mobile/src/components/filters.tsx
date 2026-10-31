import { useMemo } from 'react';
import { useGroups, useLocations, useSets, useSettings, useUpdateSettings } from '../data';
import { CONDITION_ORDER, LANGUAGE_BADGE, VARIANT_LABEL, type Variant } from '../lib/format';
import { FILTER_KEYS, type Filters } from '../lib/collection-query';
import { ChipGroup, NativeSelect, Switch, TextInput, Field } from './ui';

const ANY = '__any__';

/** All spec filters (UX §4.4). Used inside the sheet (staged) and the wide rail (instant). */
export function FilterControls({ value, onChange, rarities }: { value: Filters; onChange: (patch: Filters) => void; rarities: string[] }) {
  const sets = useSets({ owned: true, limit: 50, sort: 'name_asc', hideTcgPocket: false });
  const locations = useLocations({ limit: 50 });
  const groups = useGroups({ limit: 50 });
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const set = (k: (typeof FILTER_KEYS)[number], v: string | boolean | undefined) => onChange({ ...value, [k]: v === ANY || v === '' || v === false ? undefined : v });

  const setOptions = useMemo(() => {
    const rows = sets.data?.data ?? [];
    const opts = [{ value: ANY, label: 'Any set' }, ...rows.map((s) => ({ value: s.id, label: `${s.name} (${LANGUAGE_BADGE[s.language]})` }))];
    if (value.set && !opts.some((o) => o.value === value.set)) opts.push({ value: value.set, label: value.set });
    return opts;
  }, [sets.data, value.set]);

  return (
    <div className="flex flex-col gap-4" data-testid="filter-controls">
      <ChipGroup
        label="Language"
        value={value.lang ?? ANY}
        onChange={(v) => set('lang', v)}
        testIdPrefix="filter-lang"
        options={[{ value: ANY, label: 'All' }, { value: 'en', label: 'EN' }, { value: 'ja', label: 'JP' }]}
      />
      <NativeSelect label="Set" value={value.set ?? ANY} onChange={(v) => set('set', v)} options={setOptions} testId="filter-set" />
      {rarities.length > 0 ? (
        <NativeSelect
          label="Rarity"
          value={value.rarity ?? ANY}
          onChange={(v) => set('rarity', v)}
          testId="filter-rarity"
          options={[{ value: ANY, label: 'Any rarity' }, ...rarities.map((r) => ({ value: r, label: r })), ...(value.rarity && !rarities.includes(value.rarity) ? [{ value: value.rarity, label: value.rarity }] : [])]}
        />
      ) : (
        <Field label="Rarity" htmlFor="filter-rarity-text">
          <TextInput id="filter-rarity-text" value={value.rarity ?? ''} placeholder="Any rarity" onChange={(e) => set('rarity', e.target.value)} />
        </Field>
      )}
      <ChipGroup
        label="Condition"
        value={value.cond ?? ANY}
        onChange={(v) => set('cond', v === 'unknown' ? 'unknown' : v)}
        testIdPrefix="filter-cond"
        options={[{ value: ANY, label: 'Any' }, ...CONDITION_ORDER.map((c) => ({ value: c, label: c })), { value: 'unknown', label: 'Not set', aria: 'Condition not set' }]}
      />
      <NativeSelect
        label="Variant"
        value={value.variant ?? ANY}
        onChange={(v) => set('variant', v)}
        testId="filter-variant"
        options={[{ value: ANY, label: 'Any variant' }, ...(Object.keys(VARIANT_LABEL) as Variant[]).map((v) => ({ value: v, label: VARIANT_LABEL[v] }))]}
      />
      <ChipGroup label="Raw / graded" value={value.graded ?? ANY} onChange={(v) => set('graded', v)} options={[{ value: ANY, label: 'All' }, { value: 'raw', label: 'Raw' }, { value: 'graded', label: 'Graded' }]} />
      <div>
        <ChipGroup label="Price" value={value.priced ?? ANY} onChange={(v) => set('priced', v)} testIdPrefix="filter-priced" options={[{ value: ANY, label: 'Any' }, { value: 'some', label: 'Has price' }, { value: 'none', label: 'No price' }]} />
        <p className="mt-1 text-caption text-fg-subtle">Prices in your display currency. Change it in Settings.</p>
      </div>
      <Switch checked={!!value.dupes} onChange={(v) => set('dupes', v)} label="Duplicates" description="Only cards I have more than one of" testId="filter-dupes" />
      <NativeSelect
        label="Location"
        value={value.loc ?? ANY}
        onChange={(v) => set('loc', v)}
        testId="filter-loc"
        options={[{ value: ANY, label: 'Any location' }, { value: 'none', label: 'No location' }, ...(locations.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))]}
      />
      {(groups.data?.data.length ?? 0) > 0 && (
        <NativeSelect label="Group" value={value.group ?? ANY} onChange={(v) => set('group', v)} testId="filter-group" options={[{ value: ANY, label: 'Any group' }, ...(groups.data?.data ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
      )}
      <Field label="Collector number" htmlFor="filter-num">
        <TextInput id="filter-num" value={value.num ?? ''} placeholder="Exact number, e.g. 136 or 001" inputMode="text" onChange={(e) => set('num', e.target.value.trim())} />
      </Field>
      <Switch
        checked={settings.data?.hideTcgPocket ?? true}
        disabled={!settings.isSuccess || updateSettings.isPending}
        onChange={(v) => updateSettings.mutate({ hideTcgPocket: v })}
        label="Hide TCG Pocket (digital) cards"
        description="Digital-only cards. Applies everywhere, like the setting."
        testId="filter-hide-pocket"
      />
    </div>
  );
}
