import { Link, useNavigate } from '@tanstack/react-router';
import { MoreHorizontal, X, CircleOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AddConfirmSheet } from './add-confirm';
import { ConditionBadge, CardArt, GradeBadge, LangBadge, RarityLabel } from './card';
import { CopyEditor } from './copy-editor';
import { BottomSheet, ConfirmDialog, useToast } from './overlay';
import { Page } from './page';
import { RefreshSetRow } from './refresh-set';
import { Banner, Button, EmptyState, ErrorState, LinkButton, OfflineChip, SegmentedControl, Skeleton, cx } from './ui';
import { useCatalogCard, useOwnedCopy, useRemoveCopy, useLocations, useSettings, useUpdateCopy, type OwnedDto, type PriceDto, type Currency } from '../data';
import { errorCode } from '../lib/errors';
import { CONDITION_LABEL, VARIANT_LABEL, collectorNumber, formatDate, formatInt, formatMoney, hasJapanese, plural, variantLabel, type Variant } from '../lib/format';
import { useDelayedFlag } from '../lib/hooks';
import { haptic, useNetwork } from '../lib/native';
import { useSheetParam } from '../lib/sheets';


/* ───────── Copy list rows ───────── */

function CopyRow({ copy, onOpen, selecting, selected, onToggle, currency }: { copy: OwnedDto; onOpen: () => void; selecting: boolean; selected: boolean; onToggle: () => void; currency: Currency }) {
  const paid = copy.purchasePrice ? formatMoney(copy.purchasePrice.cents, copy.purchasePrice.currency as Currency) : null;
  const manual = copy.manualPrice ? formatMoney(copy.manualPrice.cents, copy.manualPrice.currency as Currency) : null;
  const value = copy.valuations.find((v) => v.currency === currency);
  const line1 = [variantLabel(copy.variant as Variant, copy.variantDetail), copy.grade ? null : copy.condition ?? 'Condition not recorded', copy.storageLocationName].filter(Boolean).join(' · ');
  const line2 = [paid ? `Paid ${paid}` : 'Paid —', formatDate(copy.acquisition?.purchasedOn), copy.acquisition?.source, manual ? `Your price ${manual}` : value ? `Worth ${formatMoney(value.cents, currency)}` : null].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-testid="copy-row"
      aria-label={`${variantLabel(copy.variant as Variant, copy.variantDetail)}, ${CONDITION_LABEL[copy.condition ?? 'unknown']}, ${copy.storageLocationName ?? 'no location'}, ${paid ? `paid ${paid}` : 'price paid unknown'}, ${selecting ? 'select' : 'edit'}`}
      onClick={selecting ? onToggle : onOpen}
      className="flex min-h-16 w-full items-center gap-3 px-4 py-2 text-left active:bg-surface-3"
    >
      {selecting && <span aria-hidden className={cx('inline-flex size-6 shrink-0 items-center justify-center rounded-md border', selected ? 'border-accent bg-accent text-on-accent' : 'border-border-input')}>{selected && '✓'}</span>}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-body">
          {copy.grade ? <GradeBadge grade={copy.grade} /> : <ConditionBadge condition={copy.condition as never} />}
          <span className="min-w-0 break-words">{line1}</span>
        </span>
        <span className="block break-words text-caption text-fg-muted">{line2}</span>
        {copy.grade?.certNumber && <span className="block text-caption text-fg-muted">Cert {copy.grade.certNumber}</span>}
      </span>
    </button>
  );
}

/* ───────── Prices ───────── */

function PricesTable({ prices, currencyTab }: { prices: PriceDto[]; currencyTab: Currency }) {
  const rows = prices.filter((p) => p.currency === currencyTab);
  const cols = currencyTab === 'USD' ? (['marketCents', 'lowCents', 'midCents', 'highCents'] as const) : (['trendCents', 'midCents', 'lowCents'] as const);
  const label: Record<string, string> = { marketCents: 'Market', lowCents: 'Low', midCents: currencyTab === 'EUR' ? 'Avg' : 'Mid', highCents: 'High', trendCents: 'Trend' };
  const usable = cols.filter((c) => rows.some((r) => r[c] !== null));
  const shown = rows.filter((r) => usable.some((c) => r[c] !== null));
  if (shown.length === 0) return <p className="text-small text-fg-subtle">No price data</p>;
  return (
    <table className="w-full text-small tabular-nums">
      <caption className="sr-only">{currencyTab} prices by variant</caption>
      <thead>
        <tr className="text-left text-caption text-fg-muted">
          <th scope="col" className="py-1 pr-2 font-normal">Variant</th>
          {usable.map((c) => (
            <th key={c} scope="col" className="px-1 py-1 text-right font-normal">{label[c]}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.id} className="border-t border-border">
            <th scope="row" className="py-2 pr-2 text-left font-normal">{variantLabel(r.variant as Variant, r.variantDetail)}</th>
            {usable.map((c) => (
              <td key={c} className="px-1 py-2 text-right">{formatMoney(r[c], currencyTab) ?? <span className="text-fg-subtle">—</span>}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ───────── Zoom viewer ───────── */

export function ZoomViewer({ image, name, onClose }: { image: string | null; name: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ dist: number; scale: number } | null>(null);
  const lastTap = useRef(0);
  const [touching, setTouching] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.getElementById('root')?.setAttribute('inert', '');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.getElementById('root')?.removeAttribute('inert');
    };
  }, [onClose]);
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  return (
    <div role="dialog" aria-modal="true" aria-label={`${name} card art, zoom`} data-testid="zoom-viewer" className="fixed inset-0 flex items-center justify-center bg-black" style={{ zIndex: 'var(--ps-z-blocking)', touchAction: 'none' }}>
      <button type="button" aria-label="Close zoom" onClick={onClose} className="absolute left-2 inline-flex size-(--ps-tap) items-center justify-center rounded-full bg-black/60 text-white" style={{ top: 'calc(var(--ps-safe-top) + 8px)', zIndex: 1 }}>
        <X size={22} aria-hidden />
      </button>
      <div
        className="max-h-full w-[min(92vw,640px)]"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`, transition: touching ? 'none' : 'transform var(--ps-dur-move) var(--ps-ease-standard)' }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          setTouching(true);
          if (pointers.current.size === 2) start.current = { dist: dist(), scale };
          const now = performance.now();
          if (pointers.current.size === 1 && now - lastTap.current < 300) {
            setScale((s) => (s > 1 ? 1 : 2.5));
            setPos({ x: 0, y: 0 });
          }
          lastTap.current = now;
        }}
        onPointerMove={(e) => {
          const p = pointers.current.get(e.pointerId);
          if (!p) return;
          if (pointers.current.size === 2 && start.current) {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            setScale(Math.min(5, Math.max(1, (start.current.scale * dist()) / start.current.dist)));
          } else if (scale > 1) {
            setPos((c) => ({ x: c.x + e.clientX - p.x, y: c.y + e.clientY - p.y }));
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          } else {
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          }
        }}
        onPointerUp={(e) => {
          const p = pointers.current.get(e.pointerId);
          pointers.current.delete(e.pointerId);
          if (pointers.current.size === 0) setTouching(false);
          start.current = null;
          if (p && scale === 1 && e.clientY - p.y > 0 && Math.abs(e.clientY - p.y) > 120) onClose();
        }}
      >
        <CardArt image={image} size="high" meta={{ name }} alt={`${name} card art`} rounded />
      </div>
    </div>
  );
}

/* ───────── Catalog card view ───────── */

export function CatalogCardView({
  language,
  cardId,
  forcedCopyId,
  search
}: {
  language: 'en' | 'ja';
  cardId: string;
  forcedCopyId?: string;
  search: { variant?: string; copy?: string; zoom?: boolean; add?: boolean };
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const net = useNetwork();
  const settings = useSettings();
  const sheets = useSheetParam('copy');
  const menu = useSheetParam('menu');
  const zoom = useSheetParam('zoom');
  const addSheet = useSheetParam('add');
  const [offset, setOffset] = useState(0);
  const [renderedAt] = useState(() => Date.now());
  const card = useCatalogCard({ language, cardId, copiesOffset: offset });
  const [priceTab, setPriceTab] = useState<Currency | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<'move' | 'delete' | null>(null);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const locations = useLocations({ limit: 50 });
  const remove = useRemoveCopy();
  const update = useUpdateCopy();
  const skeleton = useDelayedFlag(card.isPending);
  const currency = (settings.data?.defaultCurrency ?? 'USD') as Currency;
  const tab = priceTab ?? currency;

  const c = card.data;
  const copies = useMemo(() => c?.ownedCopies.data ?? [], [c]);
  const forced = forcedCopyId ? copies.find((x) => x.id === forcedCopyId) : undefined;
  const editId = (forced ? forced.id : undefined) ?? (search as { copy?: string }).copy;
  const editing = copies.find((x) => x.id === editId) ?? null;
  const snapshotMissing = copies.some((x) => !x.catalogAvailable);

  const grouped = useMemo(() => {
    const m = new Map<string, { variant: Variant; detail: string; n: number; conds: (string | null)[] }>();
    for (const x of copies) {
      const key = `${x.variant}|${x.variantDetail}`;
      const cur = m.get(key) ?? { variant: x.variant as Variant, detail: x.variantDetail, n: 0, conds: [] };
      cur.n++;
      cur.conds.push(x.condition);
      m.set(key, cur);
    }
    return [...m.values()];
  }, [copies]);

  const valued = copies.filter((x) => x.valuations.some((v) => v.currency === currency));
  const worth = valued.reduce((n, x) => n + (x.valuations.find((v) => v.currency === currency)?.cents ?? 0), 0);
  const allLoaded = c ? copies.length === c.ownedCount : false;

  if (card.isError && errorCode(card.error) === 'NOT_FOUND') {
    return (
      <Page title="Card not found" back={{ label: 'Collection', to: '/collection' }}>
        <EmptyState
          icon={CircleOff}
          title="Card not found"
          body="This card isn’t in the downloaded catalog. It may be in a set that’s newer than your catalog."
          action={<LinkButton to="/add" variant="primary" full>Search the catalog</LinkButton>}
          secondary={<LinkButton to="/custom-cards/new" variant="text">Create a custom card</LinkButton>}
        />
      </Page>
    );
  }
  if (card.isError) {
    return (
      <Page title="Card" back={{ label: 'Collection', to: '/collection' }}>
        <ErrorState error={card.error} onRetry={() => void card.refetch()} />
      </Page>
    );
  }
  if (!c) {
    return (
      <Page title="Card" back={{ label: 'Collection', to: '/collection' }}>
        {skeleton ? (
          <div className="flex flex-col items-center gap-3 pt-4" aria-hidden>
            <div className="shimmer aspect-card w-[min(78vw,320px)] rounded-card" />
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        ) : null}
      </Page>
    );
  }

  const pricesStale = c.latestPrices.length > 0 && renderedAt - Math.max(...c.latestPrices.map((p) => (p.sourceUpdatedAt ? Date.parse(p.sourceUpdatedAt) : 0))) > 14 * 86400000;
  const newest = c.latestPrices.map((p) => p.sourceUpdatedAt).filter((x): x is string => !!x).sort().at(-1);
  const hasPrices = c.latestPrices.some((p) => [p.marketCents, p.lowCents, p.midCents, p.highCents, p.trendCents].some((x) => x !== null));
  const closeEditor = () => (forcedCopyId ? void navigate({ to: '/cards/$language/$cardId', params: { language, cardId }, replace: true }) : sheets.close());
  const cur = (name: string) => (hasJapanese(name) ? 'ja' : undefined);

  const doBulkDelete = async () => {
    let ok = 0;
    for (const id of picked) {
      try {
        await remove.mutateAsync({ id });
        ok++;
      } catch {
        /* counted below */
      }
    }
    haptic('deleted');
    setBulk(null);
    const failed = picked.size - ok;
    setBulkMsg(failed ? `Deleted ${ok} of ${picked.size}. ${failed} couldn’t be deleted.` : null);
    if (!failed) toast.show({ message: `Deleted ${ok}` });
    setPicked(new Set());
    setSelecting(false);
  };

  const doBulkMove = async (locationId: string | null) => {
    let ok = 0;
    for (const id of picked) {
      try {
        await update.mutateAsync({ id, patch: { storageLocationId: locationId } });
        ok++;
      } catch {
        /* counted below */
      }
    }
    haptic('saved');
    setBulk(null);
    const failed = picked.size - ok;
    setBulkMsg(failed ? `Moved ${ok} of ${picked.size}. ${failed} couldn’t be moved.` : null);
    if (!failed) toast.show({ message: `Moved ${ok}` });
    setPicked(new Set());
    setSelecting(false);
  };

  return (
    <Page
      title={c.name}
      back={{ label: 'Collection', to: '/collection' }}
      add
      actions={
        <button type="button" aria-label="More actions" data-testid="card-menu" onClick={() => menu.open('1')} className="inline-flex size-(--ps-tap) items-center justify-center rounded-full text-chrome-accent">
          <MoreHorizontal size={24} aria-hidden />
        </button>
      }
    >
      <div className="lg:grid lg:grid-cols-[380px_1fr] lg:gap-8">
        <div className="flex flex-col items-center pt-2 lg:sticky lg:top-24 lg:self-start">
          <button type="button" aria-label="Zoom card art" onClick={() => zoom.open('1')} className="w-[min(78vw,320px)] lg:w-[340px]" data-testid="hero">
            <CardArt image={c.imageUrl} size="high" priority meta={{ name: c.name, setName: c.setName, localId: c.localId, rarity: c.rarity }} alt={`${c.name} — ${c.setName ?? ''} ${c.localId} card art`} className="shadow-3" />
          </button>
          <div className="mt-4 hidden w-full lg:block">
            <Button variant="primary" full onClick={() => addSheet.open('1')}>{c.ownedCount > 0 ? 'Add a copy' : 'Add to collection'}</Button>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-6 pt-4">
          <header className="flex flex-col gap-1">
            <h2 lang={cur(c.name)} className="break-words text-h1 font-bold">{c.name}</h2>
            <p className="flex flex-wrap items-center gap-x-2 text-body text-fg-muted">
              {c.setName && <Link to="/sets/$language/$setId" params={{ language, setId: c.setId }} className="inline-flex min-h-(--ps-tap) items-center text-accent-fg">{c.setName}</Link>}
              <span>{collectorNumber(c.localId, c.setOfficialCount)}</span>
              <LangBadge language={c.language} />
            </p>
            <div className="flex flex-wrap items-center gap-x-3"><RarityLabel rarity={c.rarity} />{c.illustrator && <span className="text-caption text-fg-muted">Illus. {c.illustrator}</span>}</div>
          </header>

          {snapshotMissing && (
            <Banner tone="warning" action={<LinkButton to="/settings/catalog" variant="text">Download</LinkButton>}>
              Card details aren’t downloaded — showing what you saved. Download the {language === 'en' ? 'English' : 'Japanese'} catalog to see prices and card info.
            </Banner>
          )}

          <section aria-label="Ownership" className="flex flex-col gap-3">
            {c.ownedCount > 0 ? (
              <>
                <h2 className="text-h2 font-semibold" data-testid="you-own">You own {formatInt(c.ownedCount)}</h2>
                <div className="divide-y divide-border overflow-hidden rounded-lg bg-surface">
                  {grouped.map((g) => (
                    <div key={`${g.variant}${g.detail}`} className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 text-body">
                      <span>{variantLabel(g.variant, g.detail)}</span>
                      <span className="flex items-center gap-2 tabular-nums"><span>{g.n}</span>{[...new Set(g.conds)].slice(0, 3).map((x, i) => <ConditionBadge key={i} condition={x as never} />)}</span>
                    </div>
                  ))}
                </div>
                <Button variant="primary" full data-testid="add-copy" onClick={() => addSheet.open('1')} className="lg:hidden">+ Add a copy</Button>
              </>
            ) : (
              <Button variant="primary" full data-testid="add-copy" onClick={() => addSheet.open('1')} className="lg:hidden">Add to collection</Button>
            )}
          </section>

          <section aria-label="Prices" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-h2 font-semibold">Prices</h2>
              {hasPrices && (
                <SegmentedControl label="Price source" value={tab} onChange={setPriceTab} options={[{ value: 'USD', label: 'USD', aria: 'US dollars, TCGplayer' }, { value: 'EUR', label: 'EUR', aria: 'Euros, Cardmarket' }]} />
              )}
            </div>
            {hasPrices ? (
              <>
                <PricesTable prices={c.latestPrices as PriceDto[]} currencyTab={tab} />
                <p className="flex flex-wrap items-center gap-2 text-caption text-fg-subtle">
                  {tab === 'USD' ? 'TCGplayer' : 'Cardmarket'}{newest ? ` · as of ${formatDate(newest)}` : ''}
                  {pricesStale && !net.online && <OfflineChip />}
                </p>
              </>
            ) : (
              <p className="text-small text-fg-subtle">No price data from TCGdex for this card.</p>
            )}
            {c.ownedCount > 0 && allLoaded && (
              <p className="text-small text-fg-muted">Your copies are worth {valued.length ? formatMoney(worth, currency) : '—'} ({valued.length} of {copies.length} {copies.length === 1 ? 'copy' : 'copies'} valued)</p>
            )}
            {copies.some((x) => x.grade) && <p className="text-caption text-fg-muted">Graded copies aren’t valued automatically. Set your own price in the copy.</p>}
          </section>

          {c.ownedCount > 0 && (
            <section aria-label="Copies" className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-h2 font-semibold">Copies ({formatInt(c.ownedCount)})</h2>
                <Button variant="text" onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>{selecting ? 'Done' : 'Select'}</Button>
              </div>
              {bulkMsg && <Banner tone="warning" action={<Button variant="text" onClick={() => setBulkMsg(null)}>Dismiss</Button>}>{bulkMsg}</Banner>}
              <div className="divide-y divide-border overflow-hidden rounded-lg bg-surface" data-testid="copies-list">
                {copies.map((x) => (
                  <CopyRow key={x.id} copy={x} currency={currency} selecting={selecting} selected={picked.has(x.id)} onToggle={() => setPicked((s) => { const n = new Set(s); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); return n; })} onOpen={() => sheets.open(x.id)} />
                ))}
              </div>
              {c.ownedCount > 50 && (
                <div className="flex items-center justify-between text-small text-fg-muted">
                  <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
                  <span className="tabular-nums">{offset + 1}–{Math.min(c.ownedCount, offset + 50)} of {formatInt(c.ownedCount)}</span>
                  <Button variant="secondary" disabled={offset + 50 >= c.ownedCount} onClick={() => setOffset(offset + 50)}>Next</Button>
                </div>
              )}
              {selecting && picked.size > 0 && (
                <div className="sticky z-(--ps-z-sticky) flex gap-2 rounded-lg bg-surface-2 p-2 shadow-2" style={{ bottom: 'calc(var(--ps-content-pad-bottom) + 8px)' }}>
                  <Button className="flex-1" onClick={() => setBulk('move')}>Move {picked.size} to location…</Button>
                  <Button variant="danger-outline" className="flex-1" onClick={() => setBulk('delete')}>Delete {picked.size}</Button>
                </div>
              )}
            </section>
          )}

          {c.purchaseHistory.length > 0 && (
            <section aria-label="Purchase history" className="flex flex-col gap-2">
              <h2 className="text-h2 font-semibold">Purchase history</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-lg bg-surface text-small">
                {c.purchaseHistory.map((h) => (
                  <li key={h.ownedCardId} className="px-4 py-3">
                    {[formatDate(h.acquisition.purchasedOn) ?? 'Date unknown', h.acquisition.source, h.purchasePrice ? formatMoney(h.purchasePrice.cents, h.purchasePrice.currency as Currency) : null, plural(h.acquisition.copyCount, 'copy', 'copies')].filter(Boolean).join(' · ')}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="rounded-lg bg-surface">
            <summary className="flex min-h-(--ps-tap-lg) cursor-pointer items-center justify-between px-4 text-body font-semibold">Card info</summary>
            <dl className="selectable grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 pb-4 text-small">
              <dt className="text-fg-muted">Card id</dt><dd className="break-all">{c.id}</dd>
              {c.category && (<><dt className="text-fg-muted">Category</dt><dd>{c.category}</dd></>)}
              <dt className="text-fg-muted">Variants</dt><dd>{c.availableVariants.length ? c.availableVariants.map((v) => VARIANT_LABEL[v as Variant]).join(', ') : 'Not listed'}</dd>
              {c.detailSyncedAt && (<><dt className="text-fg-muted">Details</dt><dd>Downloaded {formatDate(c.detailSyncedAt)}</dd></>)}
            </dl>
          </details>
        </div>
      </div>

      <CopyEditor copy={editing} onClose={closeEditor} defaultCurrency={currency} />
      <AddConfirmSheet target={search.add ? { kind: 'catalog', language, cardId } : null} onClose={addSheet.close} />
      {search.zoom && <ZoomViewer image={c.imageUrl} name={c.name} onClose={zoom.close} />}

      <BottomSheet open={(search as { menu?: unknown }).menu !== undefined} title="Card actions" leading="Close" onClose={menu.close} testId="card-menu-sheet">
        <div className="overflow-hidden rounded-lg bg-surface">
          <Link to="/sets/$language/$setId" params={{ language, setId: c.setId }} className="flex min-h-(--ps-tap-lg) items-center px-4 text-body active:bg-surface-3">View set</Link>
          <RefreshSetRow language={language} setId={c.setId} onDone={menu.close} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(c.id).then(() => toast.show({ message: 'Copied' }));
              menu.close();
            }}
            className="flex min-h-(--ps-tap-lg) w-full items-center px-4 text-left text-body active:bg-surface-3"
          >
            Copy card ID
          </button>
        </div>
      </BottomSheet>

      <BottomSheet open={bulk === 'move'} title={`Move ${picked.size} to location`} leading="Cancel" onClose={() => setBulk(null)}>
        <div className="overflow-hidden rounded-lg bg-surface">
          <button type="button" onClick={() => void doBulkMove(null)} className="flex min-h-(--ps-tap-lg) w-full items-center px-4 text-left text-body">{'No location'}</button>
          {(locations.data?.data ?? []).map((l) => (
            <button key={l.id} type="button" onClick={() => void doBulkMove(l.id)} className="flex min-h-(--ps-tap-lg) w-full items-center border-t border-border px-4 text-left text-body">{l.name}</button>
          ))}
        </div>
      </BottomSheet>
      <ConfirmDialog open={bulk === 'delete'} title={`Delete ${plural(picked.size, 'copy', 'copies')}?`} body="This can’t be undone." confirmLabel={`Delete ${picked.size}`} destructive busy={remove.isPending} onCancel={() => setBulk(null)} onConfirm={() => void doBulkDelete()} />

    </Page>
  );
}

/* ───────── Deep link: one copy ───────── */

export function CopyDeepLink({ ownedId }: { ownedId: string }) {
  const copy = useOwnedCopy(ownedId);
  const navigate = useNavigate();
  useEffect(() => {
    // Custom cards have their own details route; catalog copies render the catalog view with this copy's editor open.
    if (copy.data?.customCardId) void navigate({ to: '/custom-cards/$customId', params: { customId: copy.data.customCardId }, replace: true });
  }, [copy.data, navigate]);
  if (copy.isError) {
    return (
      <Page title="Copy not found" back={{ label: 'Collection', to: '/collection' }}>
        <EmptyState icon={CircleOff} title="Not found" body="This item doesn’t exist anymore. It may have been deleted." action={<LinkButton to="/collection" variant="primary" full>Back to Collection</LinkButton>} />
      </Page>
    );
  }
  if (!copy.data) return <Page title="Card" back={{ label: 'Collection', to: '/collection' }}>{null}</Page>;
  const o = copy.data;
  if (!o.catalogCardId) return <Page title={o.name} back={{ label: 'Collection', to: '/collection' }}>{null}</Page>;
  return <CatalogCardView language={o.language} cardId={o.catalogCardId} forcedCopyId={o.id} search={{}} />;
}
