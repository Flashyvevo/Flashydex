import { Link, createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { BottomSheet, ConfirmDialog, bypassSheetGuard, useToast } from '../../../components/overlay';
import { Page } from '../../../components/page';
import { Button, EmptyState, ErrorState, Field, IconButton, Skeleton, TextArea, TextInput } from '../../../components/ui';
import { useCollection, useCreateLocation, useLocations, useRemoveLocation, useUpdateLocation, type LocationDto } from '../../../data';
import { describeError, errorCode } from '../../../lib/errors';
import { formatInt, plural } from '../../../lib/format';
import { useDelayedFlag } from '../../../lib/hooks';
import { haptic } from '../../../lib/native';
import { useSheetParam } from '../../../lib/sheets';
import { MapPin } from 'lucide-react';

export const Route = createFileRoute('/_tabs/settings/locations')({
  validateSearch: z.object({ sheet: z.string().optional().catch(undefined) }),
  component: LocationsPage
});

function LocationsPage() {
  const search = Route.useSearch();
  const sheets = useSheetParam('sheet');
  const locations = useLocations({ limit: 50 });
  const unplaced = useCollection({ storageLocationId: 'none', limit: 1 });
  const remove = useRemoveLocation();
  const toast = useToast();
  const [menuFor, setMenuFor] = useState<LocationDto | null>(null);
  const [confirm, setConfirm] = useState<LocationDto | null>(null);
  const skeleton = useDelayedFlag(locations.isPending);
  const rows = locations.data?.data ?? [];
  const noLocation = unplaced.data?.pages[0]?.page.total ?? 0;
  const sheetValue = search.sheet;
  const editing = rows.find((r) => r.id === sheetValue) ?? null;

  const del = async () => {
    if (!confirm) return;
    try {
      await remove.mutateAsync({ id: confirm.id });
      haptic('deleted');
      toast.show({ message: 'Location deleted' });
    } catch (e) {
      toast.show({ message: describeError(e).body, tone: 'negative' });
    }
    setConfirm(null);
  };

  return (
    <Page title="Storage locations" back={{ label: 'Settings', to: '/settings' }} actions={<IconButton label="New location" icon={Plus} data-testid="location-new" onClick={() => sheets.open('new')} className="text-chrome-accent" />}>
      {locations.isError && <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />}
      {locations.isPending && skeleton && <div className="flex flex-col gap-2" aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
      {locations.isSuccess && rows.length === 0 && (
        <EmptyState icon={MapPin} title="No storage locations" body="Create one for each binder, box or deck so you can find any card later." action={<Button variant="primary" full onClick={() => sheets.open('new')}>Create a location</Button>} />
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface" data-testid="location-list">
          {rows.map((l) => (
            <li key={l.id} className="flex items-center">
              <Link to="/collection" search={{ loc: l.id } as never} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 pl-4 active:bg-surface-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{l.name}</span>
                  {l.description && <span className="block truncate text-caption text-fg-muted">{l.description}</span>}
                </span>
                <span className="tabular-nums text-small text-fg-muted">{formatInt(l.copyCount)}</span>
              </Link>
              <IconButton label={`More actions for ${l.name}`} icon={MoreHorizontal} onClick={() => setMenuFor(l)} />
            </li>
          ))}
        </ul>
      )}
      {noLocation > 0 && (
        <Link to="/collection" search={{ loc: 'none' } as never} className="mt-3 flex min-h-(--ps-tap-lg) items-center justify-between rounded-lg bg-surface px-4 text-body">
          <span>Cards without a location</span>
          <span className="tabular-nums text-fg-muted">{formatInt(noLocation)} ›</span>
        </Link>
      )}

      <LocationSheet open={sheetValue === 'new' || !!editing} location={sheetValue === 'new' ? null : editing} onClose={sheets.close} />
      <BottomSheet open={!!menuFor} title={menuFor?.name ?? 'Location'} leading="Close" onClose={() => setMenuFor(null)}>
        <div className="overflow-hidden rounded-lg bg-surface">
          <button type="button" className="flex min-h-(--ps-tap-lg) w-full items-center px-4 text-left text-body" onClick={() => { const id = menuFor?.id; setMenuFor(null); if (id) setTimeout(() => sheets.open(id), 0); }}>Rename or edit description</button>
          <button type="button" className="flex min-h-(--ps-tap-lg) w-full items-center border-t border-border px-4 text-left text-body text-negative" onClick={() => { setConfirm(menuFor); setMenuFor(null); }}>Delete</button>
        </div>
      </BottomSheet>
      <ConfirmDialog
        open={!!confirm}
        title={`Delete “${confirm?.name ?? ''}”?`}
        body={`${confirm && confirm.copyCount > 0 ? `${plural(confirm.copyCount, 'card')} will have no location. ` : ''}The cards themselves are not deleted.`}
        confirmLabel="Delete location"
        destructive
        busy={remove.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void del()}
      />
    </Page>
  );
}

function LocationSheet({ open, location, onClose }: { open: boolean; location: LocationDto | null; onClose: () => void }) {
  if (!open) return null;
  return <LocationForm key={location?.id ?? 'new'} location={location} onClose={onClose} />;
}

function LocationForm({ location, onClose }: { location: LocationDto | null; onClose: () => void }) {
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const toast = useToast();
  const [name, setName] = useState(location?.name ?? '');
  const [description, setDescription] = useState(location?.description ?? '');
  const [error, setError] = useState<unknown>(null);
  const dirty = name !== (location?.name ?? '') || description !== (location?.description ?? '');
  const busy = create.isPending || update.isPending;
  const submit = async () => {
    setError(null);
    try {
      if (location) await update.mutateAsync({ id: location.id, patch: { name: name.trim(), description: description.trim() || null } });
      else await create.mutateAsync({ name: name.trim(), description: description.trim() || null });
      haptic('saved');
      toast.show({ message: location ? 'Saved' : 'Location created' });
      bypassSheetGuard();
      onClose();
    } catch (e) {
      haptic('error');
      setError(e);
    }
  };
  const conflict = errorCode(error) === 'CONFLICT';
  return (
    <BottomSheet
      open
      title={location ? 'Edit location' : 'New location'}
      onClose={onClose}
      dirty={dirty}
      testId="location-sheet"
      footer={<Button variant="primary" full disabled={!name.trim()} loading={busy} onClick={() => void submit()} data-testid="location-submit">{location ? 'Save' : 'Create location'}</Button>}
    >
      <div className="flex flex-col gap-4 pt-2">
        <Field label="Name" htmlFor="loc-name" error={conflict ? `You already have a location called “${name.trim()}”` : error ? describeError(error).body : null}>
          <TextInput id="loc-name" value={name} maxLength={200} autoFocus enterKeyHint="next" onChange={(e) => setName(e.target.value)} invalid={!!error} />
        </Field>
        <Field label="Description (optional)" htmlFor="loc-desc"><TextArea id="loc-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
    </BottomSheet>
  );
}
