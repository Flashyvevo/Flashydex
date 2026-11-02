import { CATALOG_PATH_RE, WebStorageError, type RoleStore, type WebLanguage, type WebSqliteClient } from './contract';
import type { StageDone, RunOpfsStageOptions } from './opfs-staging';
import type { StageFaults } from '../pack-install/opfs-stage-protocol';

/** Process-wide handle to the prepared web storage (set by `prepareStorage` in app-database.ts once the worker + pool are up). */
export interface WebRuntime {
  client: WebSqliteClient;
  roles: RoleStore;
}

let runtime: WebRuntime | null = null;

export function setWebRuntime(next: WebRuntime | null): void {
  runtime = next;
}

export function getWebRuntime(): WebRuntime {
  if (!runtime) throw new WebStorageError('STORAGE_UNAVAILABLE', 'Web storage has not been prepared yet');
  return runtime;
}

/** The subset of A's client that B uses (so tests can fake it). */
export type InstallClient = Pick<WebSqliteClient, 'driver' | 'closePath' | 'importFromStaging' | 'unlink' | 'listFiles' | 'ensureCapacity'>;

export interface WebStoreDeps {
  client: InstallClient;
  roles: RoleStore;
  runStage: (options: RunOpfsStageOptions) => Promise<StageDone>;
  stagingJobs: { list(): Promise<string[]>; remove(job: string): Promise<void> };
  estimate: () => Promise<{ usage?: number; quota?: number } | undefined>;
  newJobId: () => string;
  now: () => string;
  /** DEV-only fault seam source (undefined in production). */
  faults?: () => StageFaults | undefined;
}

export const languageOfCatalogRef = (ref: string): WebLanguage | null => {
  const match = CATALOG_PATH_RE.exec(ref);
  return match ? (match[1] as WebLanguage) : null;
};
