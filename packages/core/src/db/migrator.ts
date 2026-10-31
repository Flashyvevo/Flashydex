export type Migration = {
  readonly id: string;
  readonly sql: string;
};

export type MigrationRunner = {
  execute(sql: string): Promise<void>;
};

/** Stage A2 placeholder; migration discovery and bookkeeping arrive with the schema. */
export async function runMigrations(_runner: MigrationRunner, _migrations: readonly Migration[]): Promise<void> {
  // Intentionally empty: no schema or SQL migrations exist yet.
}
