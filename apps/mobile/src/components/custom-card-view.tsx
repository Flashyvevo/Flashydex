import { useNavigate } from '@tanstack/react-router';
import { CircleOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AddConfirmSheet } from './add-confirm';
import { CardArt, ConditionBadge, CustomChip, GradeBadge, LangBadge } from './card';
import { CopyEditor } from './copy-editor';
import { BottomSheet, ConfirmDialog, bypassSheetGuard, useToast } from './overlay';
import { Page } from './page';
import { Banner, Button, ChipGroup, EmptyState, Field, LinkButton, TextArea, TextInput } from './ui';
import { useCollection, useCustomCard, useRemoveCustomCard, useSettings, useUpdateCustomCard, type Currency, type CustomDto, type OwnedDto } from '../data';
import { describeError, errorCode, validationIssues } from '../lib/errors';
import { collectorNumber, formatInt, hasJapanese, plural, variantLabel, type Variant } from '../lib/format';
import { haptic } from '../lib/native';
import { useSheetParam } from '../lib/sheets';

export function CustomCardView({ id, search }: { id: string; search: { copy?: string; add?: boolean; edit?: boolean } }) {
  const card = useCustomCard(id);
  const settings = useSettings();
  const copySheet = useSheetParam('copy');
  const addSheet = useSheetParam('add');
  const editSheet = useSheetParam('edit');
  const currency = (settings.data?.defaultCurrency ?? 'USD') as Currency;
  const c = card.data;
  // There is no "copies of this custom card" hook: list by name+language and keep the exact customCardId matches.
  const list = useCollection({ groupBy: 'copy', q: c?.name, language: c?.language, limit: 50 });
  const copies = useMemo(() => (list.data?.pages.flatMap((p) => p.data) ?? []).filter((o: OwnedDto) => o.customCardId === id), [list.data, id]);

  if (card.isError) {
    return (
      <Page title="Card not found" back={{ label: 'Collection', to: '/collection' }}>
        <EmptyState icon={CircleOff} title="Card not found" body="This item doesn’t exist anymore. It may have been deleted." action={<LinkButton to="/collection" variant="primary" full>Back to Collection</LinkButton>} />
      </Page>
    );
  }
  if (!c) return <Page title="Custom card" back={{ label: 'Collection', to: '/collection' }}>{null}</Page>;
  const editing = copies.find((x) => x.id === search.copy) ?? null;
  return (
    <Page title={c.name} back={{ label: 'Collection', to: '/collection' }} add>
      <div className="flex flex-col items-center pt-2">
        <div className="w-[min(78vw,320px)]">
          <CardArt image={c.imageUrl} size="high" priority meta={{ name: c.name, setName: c.setName, localId: c.localId, rarity: c.rarity }} alt={`${c.name} custom card art`} className="shadow-3" />
        </div>
      </div>
      <div className="flex flex-col gap-6 pt-4">
        <header className="flex flex-col gap-1">
          <h2 lang={hasJapanese(c.name) ? 'ja' : undefined} className="break-words text-h1 font-bold">{c.name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-body text-fg-muted">
            <CustomChip />
            {c.setName && <span>{c.setName}</span>}
            {c.localId && <span>{collectorNumber(c.localId, null)}</span>}
            <LangBadge language={c.language} />
          </p>
          {c.rarity && <p className="text-caption text-fg-muted">{c.rarity}</p>}
          {c.notes && <p className="selectable text-small text-fg-muted">{c.notes}</p>}
        </header>
        <div className="flex flex-col gap-2">
          <Button variant="primary" full data-testid="add-copy" onClick={() => addSheet.open('1')}>{c.copyCount > 0 ? '+ Add a copy' : 'Add to collection'}</Button>
          <Button full onClick={() => editSheet.open('1')} data-testid="custom-edit">Edit card details</Button>
        </div>
        {c.copyCount > 0 && (
          <section aria-label="Copies" className="flex flex-col gap-2">
            <h2 className="text-h2 font-semibold" data-testid="you-own">You own {formatInt(c.copyCount)}</h2>
            <div className="divide-y divide-border overflow-hidden rounded-lg bg-surface" data-testid="copies-list">
              {copies.map((o) => (
                <button key={o.id} type="button" data-testid="copy-row" onClick={() => copySheet.open(o.id)} className="flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-3">
                  {o.grade ? <GradeBadge grade={o.grade} /> : <ConditionBadge condition={o.condition as never} />}
                  <span className="min-w-0 flex-1 truncate text-body">{variantLabel(o.variant as Variant, o.variantDetail)}{o.storageLocationName ? ` · ${o.storageLocationName}` : ''}</span>
                </button>
              ))}
            </div>
            {c.copyCount > copies.length && <p className="text-caption text-fg-muted">Showing {plural(copies.length, 'copy', 'copies')} of {formatInt(c.copyCount)}.</p>}
          </section>
        )}
      </div>
      <CopyEditor copy={editing} onClose={copySheet.close} defaultCurrency={currency} />
      <AddConfirmSheet target={search.add ? { kind: 'custom', id } : null} onClose={addSheet.close} />
      <EditCustomSheet open={!!search.edit} card={c} onClose={editSheet.close} />
    </Page>
  );
}

function EditCustomSheet({ open, card, onClose }: { open: boolean; card: CustomDto; onClose: () => void }) {
  if (!open) return null;
  return <EditInner card={card} onClose={onClose} />;
}

function EditInner({ card, onClose }: { card: CustomDto; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const update = useUpdateCustomCard();
  const remove = useRemoveCustomCard();
  const [d, setD] = useState({ name: card.name, setName: card.setName ?? '', localId: card.localId ?? '', rarity: card.rarity ?? '', imageUrl: card.imageUrl ?? '', notes: card.notes ?? '' });
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [orig] = useState(() => JSON.stringify(d));
  const dirty = JSON.stringify(d) !== orig;
  const urlBad = d.imageUrl.trim() !== '' && !/^https?:\/\//i.test(d.imageUrl.trim());
  const issues = validationIssues(error);
  const save = async () => {
    setError(null);
    try {
      await update.mutateAsync({ id: card.id, patch: { name: d.name.trim(), setName: d.setName.trim() || null, localId: d.localId.trim() || null, rarity: d.rarity.trim() || null, imageUrl: d.imageUrl.trim() || null, notes: d.notes.trim() || null } });
      haptic('saved');
      toast.show({ message: 'Saved' });
      bypassSheetGuard();
      onClose();
    } catch (e) {
      haptic('error');
      setError(e);
    }
  };
  const del = async () => {
    try {
      await remove.mutateAsync({ id: card.id });
      haptic('deleted');
      toast.show({ message: 'Deleted' });
      bypassSheetGuard();
      setConfirm(false);
      void navigate({ to: '/collection', replace: true });
    } catch (e) {
      setConfirm(false);
      setError(e);
    }
  };
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  return (
    <BottomSheet
      open
      large
      title="Edit custom card"
      onClose={onClose}
      dirty={dirty}
      wide="panel"
      testId="custom-edit-sheet"
      footer={
        <div className="flex flex-col gap-2">
          <Button variant="primary" full disabled={!dirty || !d.name.trim() || urlBad} loading={update.isPending} onClick={() => void save()}>Save changes</Button>
          <Button variant="danger-outline" full softDisabled={card.copyCount > 0} onClick={() => setConfirm(true)} aria-describedby="del-reason">Delete card</Button>
          {card.copyCount > 0 && <p id="del-reason" className="text-center text-caption text-fg-muted">Delete the {card.copyCount} {card.copyCount === 1 ? 'copy' : 'copies'} first</p>}
        </div>
      }
    >
      <div className="flex flex-col gap-4 pt-2">
        <p className="text-caption text-fg-muted">Changes don’t alter copies you already own.</p>
        <Field label="Name" htmlFor="cc-name" error={issues.find((i) => String(i.path).includes('name'))?.message}><TextInput id="cc-name" value={d.name} onChange={set('name')} /></Field>
        <ChipGroup label="Language" value={card.language} onChange={() => undefined} options={[{ value: 'en', label: 'EN', disabled: true }, { value: 'ja', label: 'JA', disabled: true }]} />
        <Field label="Set name" htmlFor="cc-set"><TextInput id="cc-set" value={d.setName} onChange={set('setName')} /></Field>
        <Field label="Number" htmlFor="cc-num"><TextInput id="cc-num" value={d.localId} onChange={set('localId')} /></Field>
        <Field label="Rarity" htmlFor="cc-rar"><TextInput id="cc-rar" value={d.rarity} onChange={set('rarity')} /></Field>
        <Field label="Image URL" htmlFor="cc-img" error={urlBad ? 'Use an http or https link' : null} hint="Paste a link to an image. Adding your own photo comes later."><TextInput id="cc-img" inputMode="url" value={d.imageUrl} onChange={set('imageUrl')} /></Field>
        <Field label="Notes" htmlFor="cc-notes"><TextArea id="cc-notes" value={d.notes} onChange={set('notes')} /></Field>
        {error != null && <Banner tone="negative">{describeError(error).body}{errorCode(error) === 'IN_USE' ? '' : ''}</Banner>}
      </div>
      <ConfirmDialog open={confirm} title={`Delete ${card.name}?`} body="This custom card definition will be removed." confirmLabel="Delete card" destructive busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => void del()} />
    </BottomSheet>
  );
}

export { useCustomCard };
