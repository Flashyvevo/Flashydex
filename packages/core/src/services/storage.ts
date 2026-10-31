import type { StorageStatus } from '../db/sql';
import type { DatabaseSet } from '../db/database-set';

export type { StorageStatus };

/** D43 / D42: write-health of the user DB. `recover()` reopens the driver and clears the persistence latch (never replays writes). */
export class StorageService {
  constructor(private readonly databases: DatabaseSet) {}

  status(): StorageStatus {
    return this.databases.user.status();
  }

  subscribe(listener: (s: StorageStatus) => void): () => void {
    return this.databases.user.subscribe(listener);
  }

  /** driver.reopen() -> re-read persisted state -> clear latch. Throws UNSUPPORTED_CAPABILITY when the driver cannot reopen. */
  async recover(): Promise<StorageStatus> {
    const status = await this.databases.user.recover();
    await this.databases.coordinator.reconcile().catch(() => false); // an admission row stranded by the failed flush
    return status;
  }
}
