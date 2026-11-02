import { useEffect } from 'react';
import { Button, ProgressBar } from './ui';
import { formatBytes } from '../lib/format';
import { useStartupProgress } from '../data';
import type { StoragePrepareProgress } from '../platform/web-storage/contract';

const FRAME_STYLE = { paddingTop: 'var(--ps-safe-top)', paddingBottom: 'var(--ps-safe-bottom)' } as const;
const FRAME = 'flex min-h-dvh items-center justify-center bg-bg px-6';

/** Supported-browser list (WEB-STORAGE §2). Keep in step with that table. */
const SUPPORTED = [
  'Safari on iPhone and iPad (iOS 17 or newer), including the Home Screen app',
  'Safari on Mac (17 or newer)',
  'Chrome on Android (109 or newer)',
  'Chrome or Edge on a computer (108 or newer)',
  'Firefox (111 or newer)'
];

/** Is a migration-style phase running (anything past the plain pool open)? */
export function isMigrating(p: StoragePrepareProgress | null): boolean {
  return !!p && (p.phase === 'reading-legacy' || p.phase === 'importing' || p.phase === 'validating' || p.phase === 'finalizing');
}

const PHASE_LABEL: Record<string, string> = {
  'reading-legacy': 'Reading your saved collection',
  importing: 'Copying it to the new storage',
  validating: 'Checking every card came across',
  finalizing: 'Finishing up'
};

/** Full-screen, no cancel: the old copy is kept and nothing is deleted. */
export function MigrationProgressScreen() {
  const progress = useStartupProgress();
  const phase = progress?.phase ?? 'reading-legacy';
  const done = progress && 'bytesDone' in progress ? (progress.bytesDone ?? null) : null;
  const total = progress && 'bytesTotal' in progress ? (progress.bytesTotal ?? null) : null;
  // The user must not close the tab mid-move; the browser shows its own confirm.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);
  return (
    <div role="status" aria-live="polite" className={FRAME} style={FRAME_STYLE} data-testid="migration-progress">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-h3 font-semibold">Moving your collection to faster storage…</h1>
        <p className="text-body text-fg-muted">This happens once. Keep FlashyDex open. Your original copy stays on this device until you remove it.</p>
        <div className="w-full">
          <ProgressBar
            value={done}
            max={total}
            label="Moving your collection"
            valueText={done !== null && total ? `${formatBytes(done)} of ${formatBytes(total)}` : undefined}
            testId="migration-bar"
          />
        </div>
        <p className="text-small text-fg-muted" data-testid="migration-phase">
          {PHASE_LABEL[phase] ?? 'Working'}
          {done !== null && total ? ` · ${formatBytes(done)} of ${formatBytes(total)}` : ''}
        </p>
      </div>
    </div>
  );
}

const CODE_COPY: Record<string, string> = {
  STORAGE_UNAVAILABLE: 'This browser or page can’t give FlashyDex a place to keep your collection.',
  INIT_FAILED: 'FlashyDex couldn’t open its storage. Nothing was deleted.',
  PROTOCOL_MISMATCH: 'This tab is running an older version than your saved data. Reload to get the current version.',
  QUOTA: 'This device has no free space left for FlashyDex storage. Free some space, then try again.',
  CAPACITY: 'FlashyDex couldn’t reserve room in its storage. Nothing was deleted.',
  WORKER_DIED: 'The storage process stopped unexpectedly. Nothing was deleted.'
};

/**
 * Storage can't open (unsupported browser, insecure origin, failed probe). Nothing is opened or written here and there is
 * deliberately no "continue anyway": FlashyDex never falls back to a temporary copy that would lose your cards.
 */
export function StorageUnavailableScreen({ code }: { code: string }) {
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  return (
    <div role="alert" className={FRAME} style={FRAME_STYLE} data-testid="storage-unavailable">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-h3 font-semibold">FlashyDex can’t open its storage here</h1>
        <p className="text-body text-fg-muted" data-testid="storage-unavailable-reason">
          {CODE_COPY[code] ?? 'FlashyDex couldn’t open its storage.'}
          {!secure ? ' This page isn’t using https, which browsers require for private storage.' : ''}
        </p>
        <p className="text-small text-fg-muted">Nothing was changed and no cards were lost. FlashyDex won’t keep a temporary copy that disappears when you close the tab.</p>
        <div>
          <p className="text-small font-semibold">Works in</p>
          <ul className="mt-1 list-disc pl-5 text-small text-fg-muted" data-testid="supported-browsers">
            {SUPPORTED.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>
        <p className="text-caption text-fg-subtle">Private or Incognito windows may block storage or erase it when closed. Use a normal window.</p>
        <Button variant="primary" full onClick={() => window.location.reload()} data-testid="storage-retry">Retry</Button>
        <span className="text-caption text-fg-subtle">Code: {code}</span>
      </div>
    </div>
  );
}

const BLOCKED_COPY: Record<string, string> = {
  MIGRATION_BLOCKED: 'FlashyDex found saved data it can’t safely move on its own.',
  METADATA_CORRUPT: 'FlashyDex’s storage index is unreadable.'
};

/** Stable reason tokens from the migration (web-sqlite `MigrationBlockedReason`) in plain words. */
const REASON_COPY: Record<string, string> = {
  legacy_too_large: 'Your saved collection is larger than the automatic move allows (16 MB).',
  legacy_unreadable: 'Your saved collection couldn’t be read from this browser.',
  legacy_corrupt: 'Your saved collection looks damaged.',
  legacy_unsupported_schema: 'Your saved collection is from a version this build doesn’t recognise.',
  legacy_integrity_failed: 'The copy of your collection didn’t pass its safety check.',
  user_unreadable: 'The new storage couldn’t be read.',
  user_missing: 'The new storage is missing even though it should exist.',
  future_schema: 'Your data was saved by a newer version of FlashyDex. Update FlashyDex, then reload.',
  orphan_user_data: 'There are two different copies of your collection and FlashyDex won’t pick one for you.',
  validation_failed: 'The moved collection didn’t match the original, so nothing was switched.',
  client_cannot_import: 'This build can’t move your collection.'
};

function plainReason(message: string): string | null {
  const token = /Migration blocked: ([a-z_]+)/.exec(message)?.[1];
  return token ? (REASON_COPY[token] ?? null) : null;
}

/**
 * Migration refused to proceed (never silently resets). Honest recovery: say what we know, what is untouched and what to do.
 * No "start fresh" button.
 */
export function MigrationBlockedScreen({ code, message }: { code: string; message: string }) {
  return (
    <div role="alert" className={FRAME} style={FRAME_STYLE} data-testid="migration-blocked">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-h3 font-semibold">Your collection is safe, but it needs attention</h1>
        <p className="text-body text-fg-muted">{BLOCKED_COPY[code] ?? 'FlashyDex stopped before changing anything.'} Nothing was deleted or replaced.</p>
        {message && (
          <p className="selectable rounded-lg bg-surface px-3 py-2 text-small text-fg-muted" data-testid="migration-blocked-reason">
            {plainReason(message) ?? message}
          </p>
        )}
        <ul className="list-disc pl-5 text-small text-fg-muted">
          <li>Don’t clear this site’s data or reinstall the app yet. That would remove the only copy.</li>
          <li>Try Reload first. A closed tab or a brief storage error often clears.</li>
          <li>If it keeps happening, open FlashyDex in the browser or Home Screen app you used before and export a backup there (Settings → Import, export &amp; backup), then contact support with the code below.</li>
        </ul>
        <Button variant="primary" full onClick={() => window.location.reload()} data-testid="migration-reload">Reload</Button>
        <span className="text-caption text-fg-subtle">Code: {code}</span>
      </div>
    </div>
  );
}
