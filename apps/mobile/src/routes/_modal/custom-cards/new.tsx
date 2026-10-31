import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { AddConfirmSheet } from '../../../components/add-confirm';
import { CardArt } from '../../../components/card';
import { ModalPage, useCloseOrBack } from '../../../components/page';
import { useToast } from '../../../components/overlay';
import { Banner, Button, ChipGroup, Field, TextArea, TextInput } from '../../../components/ui';
import { useCreateCustomCard, useSettings, useSets } from '../../../data';
import { describeError, validationIssues } from '../../../lib/errors';
import { haptic } from '../../../lib/native';
import type { Language } from '../../../lib/format';
import { useSheetParam } from '../../../lib/sheets';

export const Route = createFileRoute('/_modal/custom-cards/new')({
  validateSearch: z.object({ name: z.string().optional().catch(undefined), created: z.string().optional().catch(undefined) }),
  component: NewCustom
});

function NewCustom() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const close = useCloseOrBack('/');
  const toast = useToast();
  const settings = useSettings();
  const create = useCreateCustomCard();
  const addSheet = useSheetParam('created');
  const [lang, setLang] = useState<Language>(settings.data?.languages[0] === 'ja' ? 'ja' : 'en');
  const [name, setCardName] = useState(search.name ?? '');
  const [setName, setSetName] = useState('');
  const [num, setNum] = useState('');
  const [rarity, setRarity] = useState('');
  const [img, setImg] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const suggestions = useSets({ language: lang, limit: 50, sort: 'name_asc', hideTcgPocket: true });
  const urlBad = img.trim() !== '' && !/^https?:\/\//i.test(img.trim());
  const issues = validationIssues(error);
  const issue = (p: string) => issues.find((i) => String(i.path).includes(p))?.message;

  const submit = async (andAdd: boolean) => {
    setError(null);
    try {
      const card = await create.mutateAsync({ name: name.trim(), language: lang, setName: setName.trim() || null, localId: num.trim() || null, rarity: rarity.trim() || null, imageUrl: img.trim() || null, notes: notes.trim() || null } as never);
      haptic('saved');
      if (andAdd) {
        void navigate({ to: '/custom-cards/new', search: { name: search.name, created: card.id } as never, replace: true });
      } else {
        toast.show({ message: `Created ${card.name}`, action: { label: 'View', onClick: () => void navigate({ to: '/custom-cards/$customId', params: { customId: card.id } }) } });
        close();
      }
    } catch (e) {
      haptic('error');
      setError(e);
    }
  };

  return (
    <ModalPage
      title="New custom card"
      onClose={close}
      footer={
        <>
          <Button variant="primary" full disabled={!name.trim() || urlBad} loading={create.isPending} onClick={() => void submit(true)} data-testid="custom-create-add">Create and add to collection</Button>
          <Button full disabled={!name.trim() || urlBad || create.isPending} onClick={() => void submit(false)} data-testid="custom-create">Create only</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-fg-muted">For cards missing from the catalog — misprints, new releases, oddities.</p>
        <Field label="Name *" htmlFor="cu-name" error={issue('name')}>
          <TextInput id="cu-name" value={name} enterKeyHint="next" onChange={(e) => setCardName(e.target.value)} autoFocus />
        </Field>
        <ChipGroup label="Language" value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'ja', label: 'JP' }]} />
        <Field label="Set name" htmlFor="cu-set">
          <TextInput id="cu-set" list="cu-sets" value={setName} enterKeyHint="next" onChange={(e) => setSetName(e.target.value)} />
          <datalist id="cu-sets">{(suggestions.data?.data ?? []).map((s) => <option key={s.id} value={s.name} />)}</datalist>
        </Field>
        <Field label="Number" htmlFor="cu-num"><TextInput id="cu-num" value={num} enterKeyHint="next" onChange={(e) => setNum(e.target.value)} /></Field>
        <Field label="Rarity" htmlFor="cu-rar"><TextInput id="cu-rar" value={rarity} enterKeyHint="next" onChange={(e) => setRarity(e.target.value)} /></Field>
        <Field label="Image URL" htmlFor="cu-img" error={urlBad ? 'Use an http or https link' : issue('imageUrl')} hint="Paste a link to an image. Adding your own photo comes later.">
          <TextInput id="cu-img" inputMode="url" value={img} enterKeyHint="next" onChange={(e) => setImg(e.target.value)} />
        </Field>
        {img.trim() && !urlBad && (
          <div className="w-24"><CardArt image={img.trim()} size="low" meta={{ name: name || 'Custom card', setName, localId: num }} /></div>
        )}
        <Field label="Notes" htmlFor="cu-notes"><TextArea id="cu-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {error != null && <Banner tone="negative">{describeError(error).body}</Banner>}
      </div>
      <AddConfirmSheet
        target={search.created ? { kind: 'custom', id: search.created } : null}
        onClose={() => {
          addSheet.close();
        }}
        onAddAnother={() => void navigate({ to: '/custom-cards/new', replace: true })}
      />
    </ModalPage>
  );
}
