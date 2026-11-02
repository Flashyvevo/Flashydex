import { CATALOG_PATH_RE, type RoleStore, type WebSqliteClient } from './contract';
import { referencedPaths } from './role-state';

export interface ReconcileSummary {
  clearedIntents: string[];
  removedStagingJobs: string[];
  unlinkedFiles: string[];
  skipped: string[];
}

/**
 * Boot reconciliation of interrupted installs (WEB-STORAGE §4 crash table, row 1 and "crash after import before registration").
 * Runs under the writer lock, so nothing else is installing: every import intent still present is interrupted.
 *
 * Deletes ONLY proven-unreferenced things:
 *  - the pool file of an intent when no role (active/previous/candidate/user) points at it;
 *  - ordinary staging job directories that no surviving intent claims;
 *  - orphan `/catalog-<lang>/g-*.db` generations referenced by no role and no intent.
 * Never touches `/user/*`, probe files, or anything a role references (active, previous and candidates are all protected).
 * Role metadata that cannot be read (METADATA_CORRUPT) propagates: nothing is swept on a guess.
 */
export async function reconcileWebStaging(deps: {
  client: Pick<WebSqliteClient, 'listFiles' | 'unlink' | 'closePath'>;
  roles: RoleStore;
  stagingJobs: { list(): Promise<string[]>; remove(job: string): Promise<void> };
}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { clearedIntents: [], removedStagingJobs: [], unlinkedFiles: [], skipped: [] };
  const state = await deps.roles.load();
  const referenced = referencedPaths(state);
  const files = new Set(await deps.client.listFiles());
  const protectedByIntent = new Set<string>();

  const unlink = async (path: string) => {
    if (!CATALOG_PATH_RE.test(path) || referenced.has(path)) {
      summary.skipped.push(path);
      return;
    }
    try {
      await deps.client.closePath(path).catch(() => undefined);
      if (await deps.client.unlink(path)) summary.unlinkedFiles.push(path);
      files.delete(path);
    } catch {
      summary.skipped.push(path); // BUSY etc.: retried at the next boot
    }
  };

  for (const intent of state.intents) {
    if (intent.target === 'user') {
      protectedByIntent.add(intent.targetRef); // A's migration intents: never ours to sweep
      if (intent.stagingJob) protectedByIntent.add(`staging:${intent.stagingJob}`);
      continue;
    }
    if (files.has(intent.targetRef)) await unlink(intent.targetRef);
    if (intent.stagingJob) {
      try {
        await deps.stagingJobs.remove(intent.stagingJob);
        summary.removedStagingJobs.push(intent.stagingJob);
      } catch {
        protectedByIntent.add(`staging:${intent.stagingJob}`);
        summary.skipped.push(`staging:${intent.stagingJob}`);
        continue; // keep the intent: the directory is still there to reconcile next boot
      }
    }
    await deps.roles.clearIntent(intent.job);
    summary.clearedIntents.push(intent.job);
  }

  for (const job of await deps.stagingJobs.list()) {
    if (protectedByIntent.has(`staging:${job}`) || summary.removedStagingJobs.includes(job)) continue;
    try {
      await deps.stagingJobs.remove(job);
      summary.removedStagingJobs.push(job);
    } catch {
      summary.skipped.push(`staging:${job}`);
    }
  }

  for (const path of files) {
    if (CATALOG_PATH_RE.test(path) && !referenced.has(path) && !protectedByIntent.has(path)) await unlink(path);
  }
  return summary;
}
