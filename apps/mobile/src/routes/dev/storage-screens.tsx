import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { setStartupProgress } from '../../data/startup-progress';
import { MigrationBlockedScreen, MigrationProgressScreen, StorageUnavailableScreen } from '../../components/storage-screens';
import { useEffect } from 'react';

/** DEV-ONLY preview of the storage failure screens for DOM/overflow checks (`/dev/storage-screens?kind=…`). Production renders nothing. */
export const Route = createFileRoute('/dev/storage-screens')({
  validateSearch: z.object({ kind: z.enum(['unavailable', 'migrating', 'blocked']).catch('unavailable') }),
  component: Preview
});

function Preview() {
  const { kind } = Route.useSearch();
  useEffect(() => {
    if (!import.meta.env.DEV || kind !== 'migrating') return;
    setStartupProgress({ phase: 'importing', bytesDone: 3_200_000, bytesTotal: 9_800_000 });
    return () => setStartupProgress(null);
  }, [kind]);
  if (!import.meta.env.DEV) return null;
  if (kind === 'migrating') return <MigrationProgressScreen />;
  if (kind === 'blocked') return <MigrationBlockedScreen code="MIGRATION_BLOCKED" message="Migration blocked: legacy_too_large" />;
  return <StorageUnavailableScreen code="STORAGE_UNAVAILABLE" />;
}
