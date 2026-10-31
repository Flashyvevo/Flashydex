import { useId } from 'react';
import { useToast } from './overlay';
import { useRefreshSet, useSyncCapabilities } from '../data';
import { describeError, isCancelled } from '../lib/errors';
import { haptic, useNetwork } from '../lib/native';
import { cx } from './ui';

/**
 * "Refresh this set" menu row (R07 UI). Driven by `sync.capabilities().refresh`: when core cannot refresh on this platform the row
 * stays aria-disabled with the capability reason, never a fake action.
 */
export function RefreshSetRow({ language, setId, className, onDone }: { language: 'en' | 'ja'; setId: string; className?: string; onDone?: () => void }) {
  const caps = useSyncCapabilities();
  const net = useNetwork();
  const refresh = useRefreshSet();
  const toast = useToast();
  const reasonId = useId();
  const blocked = !caps.refresh ? (caps.reason ?? 'Not available yet') : !net.online ? 'Connect to the internet' : null;

  const run = async () => {
    if (blocked || refresh.isPending) return;
    try {
      await refresh.mutateAsync({ language, setId });
      haptic('select');
      toast.show({ message: 'Refreshing this set…' });
      onDone?.();
    } catch (e) {
      if (!isCancelled(e)) toast.show({ message: describeError(e).body, tone: 'negative' });
    }
  };

  return (
    <button
      type="button"
      aria-disabled={blocked ? 'true' : undefined}
      aria-describedby={blocked ? reasonId : undefined}
      data-testid="refresh-set"
      onClick={() => void run()}
      className={cx('flex min-h-(--ps-tap-lg) w-full items-center justify-between px-4 text-left text-body active:bg-surface-3 aria-disabled:opacity-50', className)}
    >
      {refresh.isPending ? 'Refreshing…' : 'Refresh this set'}
      {blocked && <span id={reasonId} className="text-caption text-fg-muted">{blocked}</span>}
    </button>
  );
}
