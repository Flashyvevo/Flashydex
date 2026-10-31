import { useMemo, useState } from 'react';
import { useAcquisitionsServices } from './copy-editor-services';
import { useGroups, useLocations, useRemoveCopy, useUpdateCopy, type OwnedDto } from '../data';
import { describeError, validationIssues } from '../lib/errors';
import { CONDITION_ORDER, VARIANT_LABEL, plural, type Condition, type Currency, type Variant } from '../lib/format';
import { haptic } from '../lib/native';
import { BottomSheet, ConfirmDialog, bypassSheetGuard, useToast } from './overlay';
import { Banner, Button, ChipGroup, Field, NativeSelect, Switch, TextArea, TextInput } from './ui';

const NONE = '__none__';
const COMPANIES = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE', 'TAG', 'other'] as const;

type Draft = {
  variant: Variant;
  variantDetail: string;
  condition: Condition | null;
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
  manual: string;
  manualCurrency: Currency;
  notes: string;
};

const centsToText = (c: number | undefined | null) => (c === undefined || c === null ? '' : (c / 100).toFixed(2));
function parseCents(raw: string): number | null | 'invalid' {
  const t = raw.trim().replace(',', '.');
  if (t === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(parseFloat(t) * 100) : 'invalid';
}

function toDraft(o: OwnedDto, defaultCurrency: Currency): Draft {
  return {
    variant: o.variant as Variant,
    variantDetail: o.variantDetail,
    condition: o.condition as Condition | null,
    graded: !!o.grade,
    company: (o.grade?.company ?? 'PSA') as Draft['company'],
    companyLabel: o.grade?.companyLabel ?? '',
    grade: o.grade?.grade ?? '',
    cert: o.grade?.certNumber ?? '',
    price: centsToText(o.purchasePrice?.cents),
    currency: (o.purchasePrice?.currency ?? defaultCurrency) as Currency,
    date: o.acquisition?.purchasedOn ?? '',
    source: o.acquisition?.source ?? '',
    location: o.storageLocationId ?? NONE,
    group: o.groupIds[0] ?? NONE,
    manual: centsToText(o.manualPrice?.cents),
    manualCurrency: (o.manualPrice?.currency ?? defaultCurrency) as Currency,
    notes: o.notes ?? ''
  };
}

export function CopyEditor({ copy, onClose, defaultCurrency = 'USD', onDeleted }: { copy: OwnedDto | null; onClose: () => void; defaultCurrency?: Currency; onDeleted?: () => void }) {
  if (!copy) return null;
  return <EditorInner key={copy.id} copy={copy} onClose={onClose} defaultCurrency={defaultCurrency} onDeleted={onDeleted} />;
}

function EditorInner({ copy, onClose, defaultCurrency, onDeleted }: { copy: OwnedDto; onClose: () => void; defaultCurrency: Currency; onDeleted?: () => void }) {
  const toast = useToast();
  const update = useUpdateCopy();
  const remove = useRemoveCopy();
  const acquisitions = useAcquisitionsServices();
  const locations = useLocations({ limit: 50 });
  const groups = useGroups({ limit: 50 });
  const original = useMemo(() => toDraft(copy, defaultCurrency), [copy, defaultCurrency]);
  const [d, setD] = useState<Draft>(original);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const dirty = JSON.stringify(d) !== JSON.stringify(original);
  const price = parseCents(d.price);
  const manual = parseCents(d.manual);
  const invalid = price === 'invalid' || manual === 'invalid' || (d.graded && (d.grade.trim() === '' || (d.company === 'other' && d.companyLabel.trim() === ''))) || (d.variant === 'other' && !d.variantDetail.trim());
  const issues = validationIssues(error);
  const sharedBy = copy.acquisition?.copyCount ?? 0;
  const acquisitionChanged = d.date !== original.date || d.source !== original.source;

  const save = async () => {
    if (invalid || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (d.variant !== original.variant || d.variantDetail !== original.variantDetail) {
        patch.variant = d.variant;
        patch.variantDetail = d.variant === 'other' ? d.variantDetail.trim() : '';
      }
      if (d.condition !== original.condition) patch.condition = d.condition;
      if (d.price !== original.price || d.currency !== original.currency) patch.purchasePrice = typeof price === 'number' ? { cents: price, currency: d.currency } : null;
      if (d.location !== original.location) patch.storageLocationId = d.location === NONE ? null : d.location;
      if (d.notes !== original.notes) patch.notes = d.notes.trim() || null;
      if (d.manual !== original.manual || d.manualCurrency !== original.manualCurrency) patch.manualPrice = typeof manual === 'number' ? { cents: manual, currency: d.manualCurrency } : null;
      if (d.group !== original.group) patch.groupIds = d.group === NONE ? [] : [d.group];
      const gradeChanged = d.graded !== original.graded || d.company !== original.company || d.companyLabel !== original.companyLabel || d.grade !== original.grade || d.cert !== original.cert;
      if (gradeChanged) {
        patch.grade = d.graded ? { company: d.company, companyLabel: d.company === 'other' ? d.companyLabel.trim() : null, grade: d.grade.trim(), certNumber: d.cert.trim() || null, notes: copy.grade?.notes ?? null } : null;
      }
      if (acquisitionChanged) {
        if (copy.acquisitionId) {
          await acquisitions.update(copy.acquisitionId, { purchasedOn: d.date || null, source: d.source.trim() || null });
        } else if (d.date || d.source.trim()) {
          patch.acquisitionId = await acquisitions.create({ purchasedOn: d.date || null, source: d.source.trim() || null, notes: null });
        }
      }
      if (Object.keys(patch).length > 0) await update.mutateAsync({ id: copy.id, patch: patch as never });
      else await acquisitions.refresh();
      haptic('saved');
      toast.show({ message: 'Saved' });
      bypassSheetGuard();
      onClose();
    } catch (e) {
      haptic('error');
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync({ id: copy.id });
      haptic('deleted');
      toast.show({ message: 'Deleted' });
      setConfirmDelete(false);
      bypassSheetGuard();
      (onDeleted ?? onClose)();
    } catch (e) {
      setConfirmDelete(false);
      haptic('error');
      setError(e);
    }
  };

  const fieldIssue = (p: string) => issues.find((i) => (Array.isArray(i.path) ? i.path.join('.') : String(i.path)).includes(p))?.message ?? null;

  return (
    <BottomSheet
      open
      large
      title="Edit copy"
      onClose={onClose}
      dirty={dirty}
      wide="panel"
      testId="copy-editor"
      trailing={
        <button type="button" data-testid="copy-save" disabled={!dirty || invalid || saving} onClick={() => void save()} className="inline-flex min-h-(--ps-tap) items-center px-3 text-body font-semibold text-accent-fg disabled:text-fg-disabled">
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
      footer={
        <Button variant="text" className="text-negative" full onClick={() => setConfirmDelete(true)} data-testid="copy-delete">
          Delete copy
        </Button>
      }
    >
      <div className="flex flex-col gap-5 pt-2">
        <p className="text-small text-fg-muted">
          {copy.name}
          {copy.setName ? ` · ${copy.setName}` : ''}
        </p>
        <NativeSelect
          label="Variant"
          value={d.variant}
          onChange={(v) => set('variant', v as Variant)}
          testId="copy-variant"
          options={(Object.keys(VARIANT_LABEL) as Variant[]).map((v) => ({ value: v, label: VARIANT_LABEL[v] }))}
        />
        {d.variant === 'other' && (
          <Field label="What print is this? (required)" htmlFor="ce-vd" error={fieldIssue('variantDetail')}>
            <TextInput id="ce-vd" placeholder="Stamp, cosmos holo, misprint" value={d.variantDetail} onChange={(e) => set('variantDetail', e.target.value)} />
          </Field>
        )}
        {!d.graded && (
          <ChipGroup
            label="Condition"
            value={d.condition ?? 'unset'}
            onChange={(v) => set('condition', v === 'unset' ? null : (v as Condition))}
            testIdPrefix="copy-cond"
            options={[{ value: 'unset', label: 'Not set', aria: 'Condition not set' }, ...CONDITION_ORDER.map((c) => ({ value: c, label: c }))]}
          />
        )}
        <div className="rounded-lg bg-surface px-4">
          <Switch checked={d.graded} onChange={(v) => set('graded', v)} label="Graded" />
        </div>
        {d.graded && (
          <div className="flex flex-col gap-3">
            <ChipGroup label="Company" value={d.company} onChange={(v) => set('company', v)} options={COMPANIES.map((c) => ({ value: c, label: c === 'other' ? 'Other' : c }))} />
            {d.company === 'other' && (
              <Field label="Company name" htmlFor="ce-co">
                <TextInput id="ce-co" value={d.companyLabel} onChange={(e) => set('companyLabel', e.target.value)} />
              </Field>
            )}
            <Field label="Grade" htmlFor="ce-grade" error={fieldIssue('grade')}>
              <TextInput id="ce-grade" inputMode="decimal" value={d.grade} onChange={(e) => set('grade', e.target.value)} />
            </Field>
            <Field label="Certificate number" htmlFor="ce-cert">
              <TextInput id="ce-cert" value={d.cert} onChange={(e) => set('cert', e.target.value)} />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Paid" htmlFor="ce-paid" error={price === 'invalid' ? 'Enter an amount like 4.50' : fieldIssue('purchasePrice')}>
            <TextInput id="ce-paid" inputMode="decimal" placeholder="Unknown" value={d.price} onChange={(e) => set('price', e.target.value)} />
          </Field>
          <div className="w-28">
            <NativeSelect label="Currency" value={d.currency} onChange={(v) => set('currency', v as Currency)} options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }]} />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {sharedBy > 1 && <p className="text-caption text-fg-muted">This purchase is shared by {sharedBy} copies. Changing the date or source changes it for all of them.</p>}
          <Field label="Purchase date" htmlFor="ce-date">
            <TextInput id="ce-date" type="date" value={d.date} onChange={(e) => set('date', e.target.value)} />
          </Field>
          <Field label="Bought from" htmlFor="ce-src">
            <TextInput id="ce-src" value={d.source} onChange={(e) => set('source', e.target.value)} />
          </Field>
        </div>
        <NativeSelect label="Location" value={d.location} onChange={(v) => set('location', v)} options={[{ value: NONE, label: 'None' }, ...(locations.data?.data ?? []).map((l) => ({ value: l.id, label: l.name }))]} />
        {(groups.data?.data.length ?? 0) > 0 && (
          <NativeSelect label="Group" value={d.group} onChange={(v) => set('group', v)} options={[{ value: NONE, label: 'None' }, ...(groups.data?.data ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
        )}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Your price (overrides market)" htmlFor="ce-manual" error={manual === 'invalid' ? 'Enter an amount like 4.50' : null}>
            <TextInput id="ce-manual" inputMode="decimal" placeholder="Automatic" value={d.manual} onChange={(e) => set('manual', e.target.value)} />
          </Field>
          <div className="w-28">
            <NativeSelect label="Currency" value={d.manualCurrency} onChange={(v) => set('manualCurrency', v as Currency)} options={[{ value: 'USD', label: 'USD' }, { value: 'EUR', label: 'EUR' }]} />
          </div>
        </div>
        {d.manual && (
          <Button variant="text" className="self-start" onClick={() => set('manual', '')}>
            Clear your price
          </Button>
        )}
        <Field label="Notes" htmlFor="ce-notes">
          <TextArea id="ce-notes" value={d.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {error != null && (
          <Banner tone="negative" testId="copy-error">
            <strong className="block">{describeError(error).title}</strong>
            {describeError(error).body}
          </Banner>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete this copy of ${copy.name}?`}
        body="This can’t be undone."
        confirmLabel="Delete copy"
        destructive
        busy={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void doDelete()}
      />
    </BottomSheet>
  );
}

export { plural };
