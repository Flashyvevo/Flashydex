import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAddCopies, useCatalogCard, useCustomCard, useGroups, useLocations, useRemoveCopy, useSettings } from '../data';
import { describeError, errorCode, validationIssues } from '../lib/errors';
import { CONDITION_ORDER, LANGUAGE_BADGE, VARIANT_LABEL, collectorNumber, formatMoney, plural, preselectVariant, type Condition, type Currency, type Language, type Variant } from '../lib/format';
import { haptic } from '../lib/native';
import { readAddSession, writeAddSession, type AddSession } from '../lib/prefs';
import { CardArt, RarityLabel } from './card';
import { BottomSheet, bypassSheetGuard, useToast } from './overlay';
import { Banner, Button, ChipGroup, Field, NativeSelect, Spinner, Stepper, Switch, TextArea, TextInput } from './ui';

export type AddTarget = { kind: 'catalog'; language: Language; cardId: string } | { kind: 'custom'; id: string };

const NONE = '__none__';
const COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'other'] as const;

type Form = {
  variant: Variant;
  variantDetail: string;
  otherOpen: boolean;
  condition: Condition | null;
  qty: number;
  graded: boolean;
  company: (typeof COMPANIES)[number];
  companyLabel: string;
  grade: string;
  cert: string;
  price: string;
  currency: Currency;
  date: string;
  source: string;
  location: string;
  group: string;
  notes: string;
};

function parseCents(raw: string): number | null | 'invalid' {
  const t = raw.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid';
  return Math.round(parseFloat(t) * 100);
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export type AddedInfo = { ids: string[]; qty: number; owned: number; name: string; setName: string | null; label: string };

/** Add-confirm sheet (UX §7.3). Nothing is written until "Add to collection". `suggestedVariant` pre-selects a variant only when the catalog lists it; `onAdded` fires after the durable commit. */
export function AddConfirmSheet({ target, onClose, onAddAnother, suggestedVariant, onAdded }: { target: AddTarget | null; onClose: () => void; onAddAnother?: () => void; suggestedVariant?: Variant | null; onAdded?: (added: AddedInfo) => void }) {
  if (!target) return null;
  return <ConfirmInner key={target.kind === 'catalog' ? `${target.language}:${target.cardId}` : target.id} target={target} onClose={onClose} onAddAnother={onAddAnother} suggestedVariant={suggestedVariant ?? null} onAdded={onAdded} />;
}

function ConfirmInner({ target, onClose, onAddAnother, suggestedVariant, onAdded }: { target: AddTarget; onClose: () => void; onAddAnother?: () => void; suggestedVariant: Variant | null; onAdded?: (added: AddedInfo) => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const settings = useSettings();
  const card = useCatalogCard(target.kind === 'catalog' ? { language: target.language, cardId: target.cardId } : undefined);
  const custom = useCustomCard(target.kind === 'custom' ? target.id : undefined);
  const locations = useLocations({ limit: 50 });
  const groups = useGroups({ limit: 50 });
  const add = useAddCopies();
  const remove = useRemoveCopy();
  const baseline = useRef<number | null>(null);

  const info = useMemo(() => {
    if (target.kind === 'catalog' && card.data) {
      const c = card.data;
      return { name: c.name, setName: c.setName, localId: c.localId, setOfficialCount: c.setOfficialCount as number | null, rarity: c.rarity, image: c.imageUrl, language: c.language, available: c.availableVariants as Variant[], owned: c.ownedCount, prices: c.latestPrices };
    }
    if (target.kind === 'custom' && custom.data) {
      const c = custom.data;
      return { name: c.name, setName: c.setName, localId: c.localId, setOfficialCount: null as number | null, rarity: c.rarity, image: c.imageUrl, language: c.language, available: [] as Variant[], owned: c.copyCount, prices: [] };
    }
    return null;
  }, [target, card.data, custom.data]);

  const defaults = useMemo<Form | null>(() => {
    if (!info) return null;
    const session = readAddSession();
    const pre = preselectVariant(info.available);
    return {
      variant: target.kind === 'custom' ? 'normal' : suggestedVariant && info.available.includes(suggestedVariant) ? suggestedVariant : pre.variant,
      variantDetail: '',
      otherOpen: false,
      condition: session.keep.condition ? ((session.condition as Condition | null) ?? null) : null,
      qty: 1,
      graded: false,
      company: 'PSA',
      companyLabel: '',
      grade: '',
      cert: '',
      price: session.keep.purchase ? (session.purchase?.price ?? '') : '',
      currency: ((session.purchase?.currency as Currency | undefined) ?? settings.data?.defaultCurrency ?? 'USD') as Currency,
      date: session.keep.purchase ? (session.purchase?.date ?? '') : '',
      source: session.keep.purchase ? (session.purchase?.source ?? '') : '',
      location: session.keep.location ? (session.storageLocationId ?? NONE) : NONE,
      group: session.keep.group ? (session.groupId ?? NONE) : NONE,
      notes: ''
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.name, info?.available.join(','), settings.data?.defaultCurrency]);

  const [form, setForm] = useState<Form | null>(null);
  const [keep, setKeep] = useState<AddSession['keep']>(() => readAddSession().keep);
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<{ ids: string[]; qty: number; owned: number; label: string } | null>(null);
  const [undoState, setUndoState] = useState<string | null>(null);
  const anotherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (defaults && form === null) setForm(defaults);
    if (info && baseline.current === null) baseline.current = info.owned;
  }, [defaults, form, info]);
  useEffect(() => {
    if (done) anotherRef.current?.focus();
  }, [done]);

  const dirty = !!form && !!defaults && !done && JSON.stringify({ ...form, otherOpen: 0 }) !== JSON.stringify({ ...defaults, otherOpen: 0 });
  const issues = validationIssues(error);
  const issueFor = (path: string) => issues.find((i) => (Array.isArray(i.path) ? i.path.join('.') : String(i.path)).includes(path))?.message ?? null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const loading = target.kind === 'catalog' ? card.isPending : custom.isPending;
  const loadError = target.kind === 'catalog' ? card.error : custom.error;

  const price = form ? parseCents(form.price) : null;
  const priceInvalid = price === 'invalid';
  const needsGrade = !!form?.graded && form.grade.trim() === '';
  const needsLabel = !!form?.graded && form.company === 'other' && form.companyLabel.trim() === '';
  const needsDetail = form?.variant === 'other' && form.variantDetail.trim() === '';
  const canSubmit = !!form && !!info && !priceInvalid && !needsGrade && !needsLabel && !needsDetail && !add.isPending;

  const submit = async () => {
    if (!form || !info || !canSubmit) return;
    setError(null);
    const copy = {
      language: info.language,
      ...(target.kind === 'catalog' ? { catalogCardId: target.cardId } : { customCardId: target.id }),
      variant: form.variant,
      variantDetail: form.variant === 'other' ? form.variantDetail.trim() : '',
      condition: form.graded ? null : form.condition,
      purchasePrice: typeof price === 'number' ? { cents: price, currency: form.currency } : null,
      acquisition: form.date || form.source.trim() ? { create: { purchasedOn: form.date || null, source: form.source.trim() || null, notes: null } } : null,
      storageLocationId: form.location === NONE ? null : form.location,
      notes: form.notes.trim() || null,
      grade: form.graded ? { company: form.company, companyLabel: form.company === 'other' ? form.companyLabel.trim() : null, grade: form.grade.trim(), certNumber: form.qty === 1 && form.cert.trim() ? form.cert.trim() : null, notes: null } : null,
      groupIds: form.group === NONE ? [] : [form.group]
    };
    try {
      const result = await add.mutateAsync({ quantity: form.qty, copy: copy as never });
      haptic('added'); // after the durable commit
      writeAddSession({
        keep,
        storageLocationId: keep.location ? (form.location === NONE ? null : form.location) : null,
        groupId: keep.group ? (form.group === NONE ? null : form.group) : null,
        condition: keep.condition ? form.condition : null,
        purchase: keep.purchase ? { price: form.price, currency: form.currency, date: form.date, source: form.source } : null
      });
      const owned = (baseline.current ?? 0) + result.created;
      const label = [VARIANT_LABEL[form.variant], form.graded ? `${form.company} ${form.grade}` : form.condition].filter(Boolean).join(' · ');
      setDone({ ids: result.copies.map((c) => c.id), qty: result.created, owned, label });
      toast.show({
        message: `Added ${info.name}${info.setName ? ` · ${info.setName}` : ''}`,
        action: { label: 'View', onClick: () => void view() }
      });
      onAdded?.({ ids: result.copies.map((c) => c.id), qty: result.created, owned, name: info.name, setName: info.setName ?? null, label });
    } catch (e) {
      haptic('error');
      setError(e);
    }
  };

  const view = async () => {
    bypassSheetGuard();
    onClose();
    setTimeout(() => {
      if (target.kind === 'catalog') void navigate({ to: '/cards/$language/$cardId', params: { language: target.language, cardId: target.cardId } });
      else void navigate({ to: '/custom-cards/$customId', params: { customId: target.id } });
    }, 0);
  };

  const undo = async () => {
    if (!done) return;
    let removed = 0;
    for (const id of done.ids) {
      try {
        await remove.mutateAsync({ id });
        removed++;
      } catch {
        /* reported below */
      }
    }
    haptic('undo');
    if (removed === done.ids.length) {
      toast.show({ message: 'Removed' });
      bypassSheetGuard();
      onClose();
    } else {
      setUndoState(`Removed ${removed} of ${done.ids.length} — ${plural(done.ids.length - removed, 'copy', 'copies')} still in your collection.`);
      setDone({ ...done, ids: done.ids.slice(removed) });
    }
  };

  const footer = done ? (
    <div className="flex flex-col gap-2">
      <Button variant="primary" full ref={anotherRef} data-testid="add-another" onClick={() => { bypassSheetGuard(); onClose(); onAddAnother?.(); }}>
        Add another
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Button data-testid="undo" loading={remove.isPending} onClick={() => void undo()}>Undo</Button>
        <Button data-testid="view" onClick={() => void view()}>View</Button>
      </div>
    </div>
  ) : (
    <Button variant="primary" full data-testid="add-submit" disabled={!canSubmit} loading={add.isPending} onClick={() => void submit()}>
      {add.isPending ? 'Adding…' : form && form.qty > 1 ? `Add ${form.qty} copies` : 'Add to collection'}
    </Button>
  );

  const marketLine = (() => {
    if (!form || !info) return null;
    const p = info.prices.find((x) => x.variant === form.variant && x.marketCents !== null);
    if (!p) return null;
    const m = formatMoney(p.marketCents, p.currency as Currency);
    return m ? `Market ${m} (${VARIANT_LABEL[form.variant]})` : null;
  })();

  return (
    <BottomSheet
      open
      large
      title={info?.name ?? 'Add a card'}
      leading={done ? 'Close' : 'Cancel'}
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard this copy?"
      wide="panel"
      testId="confirm-sheet"
      footer={form && info ? footer : undefined}
    >
      {loading || (!form && !loadError) ? (
        <div className="flex justify-center py-12" role="status" aria-label="Loading card"><Spinner size={24} /></div>
      ) : loadError || !info || !form ? (
        <Banner tone="negative">{describeError(loadError).body}</Banner>
      ) : done ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center" role="status">
          <CheckCircle2 size={56} className="text-positive" style={{ animation: 'fd-pop var(--ps-dur-move) var(--ps-ease-spring) both' }} aria-hidden />
          <h3 className="text-h3 font-semibold">Added {info.name} × {done.qty}</h3>
          <p className="text-body text-fg-muted">{[info.setName, done.label].filter(Boolean).join(' · ')}</p>
          <p className="text-body">You now own {done.owned}</p>
          {undoState && <Banner tone="warning">{undoState}</Banner>}
        </div>
      ) : (
        <div className="flex flex-col gap-5 pt-1">
          <div className="flex gap-3">
            <div className="w-28 shrink-0">
              <CardArt image={info.image} size="high" lowFirst meta={{ name: info.name, setName: info.setName, localId: info.localId, rarity: info.rarity }} alt={`${info.name} card art`} />
            </div>
            <div className="min-w-0">
              <h3 className="break-words text-h3 font-semibold">{info.name}</h3>
              <p className="text-small text-fg-muted">{[info.setName, collectorNumber(info.localId, info.setOfficialCount)].filter(Boolean).join(' · ')}</p>
              <div className="mt-1 flex items-center gap-2 text-caption text-fg-muted">
                <RarityLabel rarity={info.rarity} />
                <span>{LANGUAGE_BADGE[info.language]}</span>
              </div>
              {marketLine && <p className="mt-1 text-small text-fg-muted">{marketLine}</p>}
            </div>
          </div>

          {target.kind === 'catalog' && (
            <div>
              <ChipGroup
                label="Variant"
                value={form.variant}
                onChange={(v) => set('variant', v)}
                testIdPrefix="variant-chip"
                options={(info.available.length ? info.available : (['normal'] as Variant[])).map((v) => ({ value: v, label: VARIANT_LABEL[v] }))}
              />
              {info.available.length === 0 && <p className="text-caption text-warning">This print isn’t listed. Pick the closest one.</p>}
              <button type="button" onClick={() => set('otherOpen', !form.otherOpen)} className="mt-1 inline-flex min-h-(--ps-tap) items-center text-small text-accent-fg">
                Other…
              </button>
              {form.otherOpen && (
                <div className="flex flex-col gap-2">
                  <ChipGroup
                    label="Any variant"
                    hideLabel
                    value={form.variant}
                    onChange={(v) => set('variant', v)}
                    options={(Object.keys(VARIANT_LABEL) as Variant[]).map((v) => ({ value: v, label: VARIANT_LABEL[v] }))}
                  />
                  {form.variant === 'other' && (
                    <Field label="What print is this? (required)" htmlFor="variant-detail" error={needsDetail ? 'Say what print this is' : issueFor('variantDetail')}>
                      <TextInput id="variant-detail" placeholder="Stamp, cosmos holo, misprint" value={form.variantDetail} onChange={(e) => set('variantDetail', e.target.value)} />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )}

          {!form.graded && (
            <ChipGroup
              label="Condition"
              value={form.condition ?? 'unset'}
              onChange={(v) => set('condition', v === 'unset' ? null : (v as Condition))}
              testIdPrefix="condition-chip"
              options={[{ value: 'unset', label: 'Not set', aria: 'Condition not set' }, ...CONDITION_ORDER.map((c) => ({ value: c, label: c }))]}
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="text-body">Quantity</span>
            <Stepper value={form.qty} onChange={(v) => set('qty', v)} testId="qty-input" />
          </div>

          <div className="rounded-lg bg-surface px-4">
            <Switch checked={form.graded} onChange={(v) => set('graded', v)} label="Graded" testId="graded-switch" />
          </div>
          {form.graded && (
            <div className="flex flex-col gap-3">
              <ChipGroup label="Company" value={form.company} onChange={(v) => set('company', v)} options={COMPANIES.map((c) => ({ value: c, label: c === 'other' ? 'Other' : c }))} />
              {form.company === 'other' && (
                <Field label="Company name" htmlFor="company-label" error={needsLabel ? 'Required' : null}>
                  <TextInput id="company-label" value={form.companyLabel} onChange={(e) => set('companyLabel', e.target.value)} />
                </Field>
              )}
              <Field label="Grade" htmlFor="grade" error={issueFor('grade')}>
                <TextInput id="grade" inputMode="decimal" value={form.grade} placeholder="e.g. 9.5 or Authentic" onChange={(e) => set('grade', e.target.value)} />
              </Field>
              <Field label="Certificate number (optional)" htmlFor="cert" hint={form.qty > 1 ? 'Add slabs with certificate numbers one at a time' : undefined}>
                <TextInput id="cert" value={form.cert} disabled={form.qty > 1} onChange={(e) => set('cert', e.target.value)} />
              </Field>
            </div>
          )}

          <div>
            <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)} className="flex min-h-(--ps-tap) w-full items-center justify-between text-body font-semibold">
              More details
              <ChevronDown size={18} className={moreOpen ? 'rotate-180' : ''} aria-hidden />
            </button>
            {moreOpen && (
              <div className="flex flex-col gap-3 pt-1">
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <Field label="Paid per copy" htmlFor="paid" error={priceInvalid ? 'Enter an amount like 4.50' : issueFor('purchasePrice')}>
                    <TextInput id="paid" inputMode="decimal" placeholder="0.00" value={form.price} invalid={priceInvalid} onChange={(e) => set('price', e.target.value)} />
                  </Field>
                  <div className="w-28">
                    <NativeSelect label="Currency" value={form.currency} onChange={(v) => set('currency', v as Currency)} options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }]} />
                  </div>
                </div>
                <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                  <Field label="Purchase date" htmlFor="pdate">
                    <TextInput id="pdate" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
                  </Field>
                  <Button className="min-h-(--ps-tap-lg)" onClick={() => set('date', todayIso())}>Today</Button>
                </div>
                <Field label="Bought from" htmlFor="psource">
                  <TextInput id="psource" placeholder="e.g. Local game store" value={form.source} onChange={(e) => set('source', e.target.value)} />
                </Field>
                <NativeSelect label="Location" value={form.location} onChange={(v) => set('location', v)} testId="add-location" options={[{ value: NONE, label: 'None' }, ...(locations.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
                {(groups.data?.data.length ?? 0) > 0 && (
                  <NativeSelect label="Group" value={form.group} onChange={(v) => set('group', v)} options={[{ value: NONE, label: 'None' }, ...(groups.data?.data ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
                )}
                <Field label="Notes" htmlFor="pnotes">
                  <TextArea id="pnotes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
                </Field>
                <div className="rounded-lg bg-surface px-4">
                  <Switch checked={keep.location} onChange={(v) => setKeep({ ...keep, location: v })} label="Use location for the next cards too" />
                  <Switch checked={keep.condition} onChange={(v) => setKeep({ ...keep, condition: v })} label="Keep condition for next card" />
                  <Switch checked={keep.purchase} onChange={(v) => setKeep({ ...keep, purchase: v })} label="Keep purchase details for next card" />
                </div>
              </div>
            )}
          </div>

          {error != null && (
            <Banner tone="negative" testId="add-error">
              <strong className="block">{describeError(error).title}</strong>
              {errorCode(error) === 'VALIDATION_ERROR' && issues.length > 0 ? issues.map((i) => i.message).join(' · ') : describeError(error).body}
            </Banner>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
