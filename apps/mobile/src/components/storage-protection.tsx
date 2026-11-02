import { useNavigate } from '@tanstack/react-router';
import { Image as ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BottomSheet, ConfirmDialog, useToast } from './overlay';
import { Button, ChipGroup, Group, NavRow, SectionCaption } from './ui';
import { formatBytes, formatDate } from '../lib/format';
import { isNative } from '../lib/native';
import { dismissProtectionPrompt, useProtectionPromptOpen } from '../lib/protection-prompt';
import { PERSIST_LABEL, useImageCacheStats, useProtection } from '../lib/pwa-hooks';
import { IMAGE_CACHE_COPY, imageCache, PROTECT_RESULT_COPY, PROTECTION_COPY, storageProtection } from '../lib/pwa-bridge';
import { IMAGE_CACHE_LIMITS } from '../platform/web-storage/contract';

/**
 * Storage protection explanation + the one real action (`persist()` request). Copy is deliberately exact (WEB-STORAGE §2):
 * a button tap is a REQUEST; we show what the browser answered, never "prompt accepted".
 */
export function ProtectionSheet({ open, onClose, intro }: { open: boolean; onClose: () => void; intro?: boolean }) {
  const snap = useProtection();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) void storageProtection.check().catch(() => undefined);
  }, [open]);
  const info = PERSIST_LABEL[snap.persist];
  const request = async () => {
    setBusy(true);
    try {
      await storageProtection.request();
    } catch {
      /* the snapshot already reflects check-failed */
    } finally {
      setBusy(false);
    }
  };
  const backup = () => {
    onClose();
    void navigate({ to: '/settings/data', replace: false });
    setTimeout(() => document.querySelector('[data-testid="export-json"]')?.scrollIntoView({ block: 'center' }), 250);
  };
  return (
    <BottomSheet
      open={open}
      title={intro ? 'Protect your collection' : 'Storage protection'}
      leading="Close"
      onClose={onClose}
      testId="protection-sheet"
      footer={
        <div className="flex flex-col gap-2">
          {snap.persist !== 'granted' && snap.persist !== 'unavailable' && (
            <Button variant="primary" full loading={busy} onClick={() => void request()} data-testid="protect-request">
              Protect my collection
            </Button>
          )}
          <Button variant={snap.persist === 'granted' || snap.persist === 'unavailable' ? 'primary' : 'text'} full onClick={onClose} data-testid="protection-close">
            {intro ? 'Not now' : 'Close'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <div data-testid="protection-status" data-persist={snap.persist}>
          <p className="text-body font-semibold" data-testid="protection-label">{info.label}</p>
          <p className="text-small text-fg-muted">{info.detail}</p>
          {snap.requested && snap.persist === 'best-effort' && (
            <p className="mt-1 text-small text-warning" data-testid="protection-declined">{PROTECT_RESULT_COPY.notGranted}</p>
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small" data-testid="protection-usage">
          <dt className="text-fg-muted">Used by FlashyDex</dt>
          <dd className="text-right">{snap.usageBytes === null ? 'Unknown' : formatBytes(snap.usageBytes)}</dd>
          <dt className="text-fg-muted">Browser allowance</dt>
          <dd className="text-right">{snap.quotaBytes === null ? 'Unknown' : formatBytes(snap.quotaBytes)}</dd>
          <dt className="text-fg-muted">Last checked</dt>
          <dd className="text-right" data-testid="protection-checked">{snap.checkedAt ? (formatDate(snap.checkedAt, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) ?? snap.checkedAt) : 'Not yet'}</dd>
        </dl>
        <p className="text-small text-fg-muted">{PROTECTION_COPY.intro}</p>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-small text-fg-muted" data-testid="protection-bullets">
          {PROTECTION_COPY.bullets.map((b) => <li key={b}>{b}</li>)}
        </ul>
        <Button variant="secondary" full onClick={backup} data-testid="protection-backup">Back up or export my collection</Button>
      </div>
    </BottomSheet>
  );
}

/** One-time sheet mounted at the root (first personal save / before the first full catalog download). */
export function ProtectionPrompt() {
  const open = useProtectionPromptOpen();
  return <ProtectionSheet open={open} onClose={dismissProtectionPrompt} intro />;
}

const LIMIT_OPTIONS = [
  { value: String(IMAGE_CACHE_LIMITS.min), label: '150 MB' },
  { value: String(IMAGE_CACHE_LIMITS.default), label: '200 MB' },
  { value: String(IMAGE_CACHE_LIMITS.max), label: '250 MB' }
];

/** Settings → Data: "Storage protection" + "Offline card art". Web only. */
export function StorageSection() {
  const snap = useProtection();
  const [open, setOpen] = useState(false);
  const art = useImageCacheStats();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const toast = useToast();
  if (isNative()) return null;
  const info = PERSIST_LABEL[snap.persist];
  const stats = art.stats;
  const used = stats ? stats.committedBytes + stats.reservedBytes : 0;
  const selected = stats && LIMIT_OPTIONS.some((o) => o.value === String(stats.limitBytes)) ? String(stats.limitBytes) : String(IMAGE_CACHE_LIMITS.default);
  return (
    <>
      <SectionCaption>Storage on this device</SectionCaption>
      <Group>
        <NavRow
          label="Storage protection"
          description={snap.usageBytes !== null && snap.quotaBytes !== null ? `${formatBytes(snap.usageBytes)} used of about ${formatBytes(snap.quotaBytes)}` : 'Whether your browser may clear FlashyDex'}
          value={info.label}
          onClick={() => setOpen(true)}
          testId="row-storage-protection"
        />
        <div className="flex flex-col gap-3 px-4 py-3" data-testid="offline-art">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-fg" aria-hidden><ImageIcon size={20} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium">Offline card art</p>
              <p className="text-caption text-fg-muted" data-testid="art-usage">
                {!stats ? 'Checking…' : stats.enforced ? `${formatBytes(used)} used of ${formatBytes(stats.limitBytes)} · ${stats.entries} pictures` : 'Not limited by FlashyDex in this browser'}
              </p>
            </div>
          </div>
          {stats && !stats.enforced && (
            <p className="text-caption text-fg-muted" data-testid="art-reason">{stats.reason ?? 'The picture cache isn’t active yet. Card art still loads from the internet.'}</p>
          )}
          {stats?.enforced && (
            <>
              <ChipGroup
                label="Keep up to"
                value={selected}
                onChange={(v) => void art.set(imageCache.setLimit(Number(v)))}
                testIdPrefix="art-limit"
                options={LIMIT_OPTIONS}
              />
              <Button variant="secondary" full disabled={used === 0} onClick={() => setConfirmClear(true)} data-testid="art-clear">Clear offline art</Button>
            </>
          )}
          <p className="text-caption text-fg-subtle">{IMAGE_CACHE_COPY.body}</p>
        </div>
      </Group>
      <ProtectionSheet open={open} onClose={() => setOpen(false)} />
      <ConfirmDialog
        open={confirmClear}
        title="Clear offline card art?"
        body="Pictures will load from the internet again. Your collection, notes and catalogs aren’t touched."
        confirmLabel="Clear"
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setClearing(true);
          void imageCache.clear().then(
            (s) => { void art.set(Promise.resolve(s)); toast.show({ message: 'Offline art cleared' }); },
            () => toast.show({ message: 'Couldn’t clear offline art', tone: 'negative' })
          ).finally(() => { setClearing(false); setConfirmClear(false); });
        }}
        testId="art-clear-confirm"
      />
    </>
  );
}
