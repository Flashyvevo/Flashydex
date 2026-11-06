import { expect, test, type Page } from '@playwright/test';

/** Run a harness scenario inside the page (module state persists until reload). */
const h = <T = unknown>(page: Page, scenario: string, args: Record<string, unknown> = {}): Promise<T> =>
  page.evaluate(([s, a]) => import('/src/platform/web-sqlite/harness.ts').then((m) => m.run(s as string, a as Record<string, unknown>)), [scenario, args] as const) as Promise<T>;

const USER = '/user/u-harness01.db';
const CAT = '/catalog-en/g-e2eimport01.db';
const CAT_B = '/catalog-en/g-e2eimport02.db';
const MIB = 1024 * 1024;

type Staged = { job: string; name: string; bytes: number; sha256: string };
type ImportOutcome = {
  ok: boolean;
  result?: { bytes: number; sha256: string; ms: number; maxChunkBytes: number };
  error?: { code: string; commitState: string | null; message: string };
  userWrites: number;
  messages: { messages: number; maxBufferBytes: number };
  wallMs?: number;
};

test.beforeEach(async ({ page }) => {
  await page.goto('/harness.html');
});

test.describe('worker + sahpool (W01)', () => {
  test('init reports version, capacity >= 16, no SharedArrayBuffer/COOP requirement', async ({ page }) => {
    const r = await h<{
      info: { packageVersion: string; sqliteVersion: string; vfs: string; poolDirectory: string; capacity: number; fileCount: number; sessionId: string; timings: Record<string, number> };
      stats: { capacity: number; wasmMemoryBytes: number | null; workerHeapUsedBytes: number | null; unavailable: Record<string, string> };
      crossOriginIsolated: boolean;
      sharedArrayBuffer: string;
    }>(page, 'init');
    console.log('INIT', JSON.stringify({ info: r.info, wasm: r.stats.wasmMemoryBytes, heap: r.stats.workerHeapUsedBytes, unavailable: r.stats.unavailable }));
    expect(r.info.packageVersion).toBe('3.54.1-build1');
    expect(r.info.sqliteVersion).toBe('3.54.1');
    expect(r.info.vfs).toBe('opfs-sahpool');
    expect(r.info.poolDirectory).toBe('/flashydex-sqlite-v1');
    expect(r.info.capacity).toBeGreaterThanOrEqual(16);
    expect(r.info.timings.poolReadyMs).toBeGreaterThan(0);
    expect(r.crossOriginIsolated).toBe(false); // works without COOP/COEP
    expect(r.stats.wasmMemoryBytes).toBeGreaterThan(1_000_000);
  });

  test('commit -> reload -> reopen: data present (clearOnInit:false proven by survival across re-init)', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'persisted-①-日本語' });
    await page.reload();
    await h(page, 'init');
    const rows = await h<unknown[][]>(page, 'read-rows');
    expect(rows).toEqual([[1, 'persisted-①-日本語']]);
    const files = await h<string[]>(page, 'list');
    expect(files).toContain(USER);
    // the commit/reopen probe file is unlinked after use and never lingers
    expect(files.filter((f) => f.startsWith('/probe/'))).toEqual([]);
  });

  test('RETURNING (all/get/run), trailing-statement rejection, constraint text, blobs and rollback over the real worker', async ({ page }) => {
    await h(page, 'init');
    const r = await h<{
      all: unknown[][]; get: unknown[]; run: unknown[][]; counted: unknown[]; trailing: string; constraint: string; afterRollback: unknown[]; blobIsU8: boolean; blob: number[];
    }>(page, 'returning-tx');
    expect(r.all).toEqual([[1, 'アルファ', expect.anything()], [2, 'beta', null]]);
    expect(r.get).toEqual([3, 'g1']);
    expect(r.run).toEqual([[5]]);
    expect(r.counted).toEqual([5]); // the `get` multi-row INSERT was drained to completion
    expect(r.trailing).toBe('SQLITE');
    expect(r.constraint).toMatch(/UNIQUE constraint failed/);
    expect(r.afterRollback).toEqual([0]);
    expect(r.blobIsU8).toBe(true);
    expect(r.blob).toEqual([0, 255, 1]);
  });
});

test.describe('streamed import (W06)', () => {
  test.setTimeout(180_000);

  test('~20 MB staged file: <= 256 KiB slices, sha matches, interleaved USER writes keep both sides intact, no >= 1 MiB buffer crosses postMessage', async ({ page }) => {
    await h(page, 'init');
    const staged = await h<Staged>(page, 'make-staged-db', { megabytes: 20 });
    expect(staged.bytes).toBeGreaterThan(19 * MIB);
    await h(page, 'fault', { fault: { chunkDelayMs: 2 } }); // widen the window so USER commits provably interleave
    const r = await h<ImportOutcome>(page, 'import', { job: staged.job, target: CAT, bytes: staged.bytes, sha256: staged.sha256, interleaveUser: true });
    console.log('IMPORT', JSON.stringify({ mbps: staged.bytes / MIB / ((r.result?.ms ?? 1) / 1000), ms: r.result?.ms, wallMs: r.wallMs, userWrites: r.userWrites, max: r.messages.maxBufferBytes }));
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.result?.bytes).toBe(staged.bytes);
    expect(r.result?.sha256).toBe(staged.sha256);
    expect(r.result?.maxChunkBytes).toBeLessThanOrEqual(262144);
    expect(r.result?.maxChunkBytes).toBeGreaterThan(0);
    expect(r.userWrites).toBeGreaterThan(5);
    expect(r.messages.maxBufferBytes).toBeLessThan(MIB);
    // USER side: every committed write is there and the file is healthy
    const user = await h<{ integrity: unknown[][]; logRows: unknown[][]; maxLog: unknown[][] }>(page, 'user-integrity');
    expect(user.integrity).toEqual([['ok']]);
    expect(user.logRows).toEqual([[r.userWrites]]);
    // candidate side: opens, passes integrity_check, and its bytes hash to the staged hash
    const candidate = await h<{ integrity: unknown[][]; count: unknown[]; bytes: number; sha256: string }>(page, 'verify-candidate', { path: CAT });
    expect(candidate.integrity).toEqual([['ok']]);
    expect(candidate.bytes).toBe(staged.bytes);
    expect(candidate.sha256).toBe(staged.sha256);
    // survives a reload (pool persistence)
    await page.reload();
    await h(page, 'init');
    expect(await h<string[]>(page, 'list')).toEqual(expect.arrayContaining([CAT, USER]));
  });

  test('wrong expected hash -> INTEGRITY and the target is unlinked; USER untouched', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'keep-me' });
    const staged = await h<Staged>(page, 'make-staged-db', { megabytes: 2 });
    const r = await h<ImportOutcome>(page, 'import', { job: staged.job, target: CAT, bytes: staged.bytes, sha256: 'b'.repeat(64) });
    expect(r.error?.code).toBe('INTEGRITY');
    expect(await h<string[]>(page, 'list')).toEqual([USER]);
    expect(await h(page, 'read-rows')).toEqual([[1, 'keep-me']]);
  });

  test('injected short write -> INTEGRITY, quota -> QUOTA, I/O -> IO; nothing else is touched and the import works afterwards', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'keep-me' });
    const staged = await h<Staged>(page, 'make-staged-db', { megabytes: 4 });
    const args = { job: staged.job, target: CAT, bytes: staged.bytes, sha256: staged.sha256 };
    await h(page, 'fault', { fault: { supplier: { kind: 'short', afterBytes: 512 * 1024 } } });
    expect((await h<ImportOutcome>(page, 'import', args)).error?.code).toBe('INTEGRITY');
    await h(page, 'fault', { fault: { supplier: { kind: 'quota', afterBytes: 512 * 1024 } } });
    expect((await h<ImportOutcome>(page, 'import', args)).error?.code).toBe('QUOTA');
    await h(page, 'fault', { fault: { supplier: { kind: 'io', afterBytes: 512 * 1024 } } });
    expect((await h<ImportOutcome>(page, 'import', args)).error?.code).toBe('IO');
    expect(await h<string[]>(page, 'list')).toEqual([USER]);
    expect(await h(page, 'read-rows')).toEqual([[1, 'keep-me']]);
    await h(page, 'fault', { fault: {} });
    expect((await h<ImportOutcome>(page, 'import', { ...args, target: CAT_B })).ok).toBe(true);
  });

  test('worker killed mid-import: old files intact, target absent (or unlinkable) after the next init', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'survivor' });
    await h(page, 'close-driver');
    const staged = await h<Staged>(page, 'make-staged-db', { megabytes: 8 });
    const r = await h<{ outcome: { ok: boolean; error?: { code: string } }; files: string[] }>(page, 'import-then-kill', {
      job: staged.job, target: CAT, bytes: staged.bytes, sha256: staged.sha256, afterBytes: 2 * MIB
    });
    expect(r.outcome.ok).toBe(false);
    expect(r.outcome.error?.code).toBe('WORKER_DIED');
    console.log('AFTER-KILL files', JSON.stringify(r.files));
    expect(r.files).toContain(USER);
    if (r.files.includes(CAT)) expect(await h(page, 'unlink', { path: CAT })).toBe(true);
    expect(await h<string[]>(page, 'list')).toEqual([USER]);
    expect(await h(page, 'read-rows')).toEqual([[1, 'survivor']]);
    await h(page, 'fault', { fault: {} });
    const again = await h<ImportOutcome>(page, 'import', { job: staged.job, target: CAT, bytes: staged.bytes, sha256: staged.sha256 });
    expect(again.ok).toBe(true);
  });

  test('ensureCapacity grows the persistent pool and never deletes anything', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'x' });
    await h(page, 'close-driver');
    const grown = await h<{ capacity: number; fileCount: number }>(page, 'ensure-capacity', { slots: 30 });
    expect(grown.capacity).toBeGreaterThanOrEqual(grown.fileCount + 30);
    await page.reload();
    const info = await h<{ info: { capacity: number } }>(page, 'init');
    expect(info.info.capacity).toBeGreaterThanOrEqual(grown.capacity);
    expect(await h(page, 'read-rows')).toEqual([[1, 'x']]);
  });
});

test.describe('init failure / exclusivity (W01, W09 storage side)', () => {
  test.setTimeout(120_000);

  test('injected init failure with an existing USER -> INIT_FAILED, nothing wiped, clean re-init sees the USER and its rows', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'precious' });
    await h(page, 'shutdown');
    for (const initFail of ['before-vfs', 'after-vfs']) {
      await h(page, 'new-client', { fault: { initFail } });
      const failed = await h<{ ok: boolean; error?: { code: string } }>(page, 'try-init');
      expect(failed.ok).toBe(false);
      expect(failed.error?.code).toBe('INIT_FAILED');
    }
    await h(page, 'new-client');
    const ok = await h<{ ok: boolean; info?: { fileCount: number } }>(page, 'try-init');
    expect(ok.ok).toBe(true);
    expect(ok.info?.fileCount).toBe(1);
    expect(await h<string[]>(page, 'list')).toEqual([USER]);
    expect(await h(page, 'read-rows')).toEqual([[1, 'precious']]);
  });

  test('a second page in the same profile cannot take the pool while the first holds it (the writer lock must come first)', async ({ page, context }) => {
    await h(page, 'init');
    await h(page, 'write-row', { value: 'owner' });
    const second = await context.newPage();
    await second.goto('/harness.html');
    const blocked = await h<{ ok: boolean; error?: { code: string } }>(second, 'try-init');
    expect(blocked.ok).toBe(false);
    expect(['INIT_FAILED', 'STORAGE_UNAVAILABLE']).toContain(blocked.error?.code);
    expect(await h(page, 'read-rows')).toEqual([[1, 'owner']]);
    await h(page, 'shutdown');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h(second, 'new-client');
    const ok = await h<{ ok: boolean }>(second, 'try-init');
    expect(ok.ok).toBe(true);
    expect(await h(second, 'read-rows')).toEqual([[1, 'owner']]);
  });
});

type Seed = { dump: Record<string, string[]>; ops: Record<string, unknown[][]>; bytes: number; sha256: string; legacy: Record<string, { bytes: number; sha256: string }> };
type EnsureResult = {
  ok: boolean;
  outcome?: { kind: string; path: string; legacyBytes?: number; counts?: Record<string, number>; ms?: number };
  error?: { code: string; reason: string | null };
  phases: string[];
  role?: { path: string; origin: string } | null;
  marker?: { legacyRetained: boolean; legacySha256: string; legacyBytes: number; userPath: string; counts: Record<string, number> } | null;
  files: string[];
};
type UserDump = { path: string; dump: Record<string, string[]>; ops: Record<string, unknown[][]>; integrity: unknown[][]; fk: unknown[][] };

test.describe('jeep -> OPFS USER migration (W10)', () => {
  test.setTimeout(120_000);

  test('seeded jeepSqliteStore key -> migrated: counts equal, values byte-equal, stale receipts reset, legacy + catalog keys untouched, rerun -> existing', async ({ page }) => {
    await h(page, 'init');
    const seed = await h<Seed>(page, 'seed-legacy', { extraOwned: 30 });
    expect(Object.keys(seed.legacy).sort()).toEqual(['flashydex-catalog-enSQLite.db', 'flashydex-userSQLite.db']);
    await h(page, 'message-stats', { reset: true });
    const r = await h<EnsureResult>(page, 'ensure-user');
    console.log('MIGRATE', JSON.stringify({ ms: r.outcome?.ms, bytes: r.outcome?.legacyBytes, phases: r.phases }));
    expect(r.error).toBeUndefined();
    expect(r.outcome?.kind).toBe('migrated');
    expect(r.outcome?.path).toMatch(/^\/user\/m-[a-z0-9]+\.db$/);
    expect(r.phases).toEqual(['checking', 'reading-legacy', 'importing', 'importing', 'validating', 'finalizing']);
    expect(r.outcome?.counts?.owned_cards).toBe(33);
    expect(r.marker).toMatchObject({ legacyRetained: true, legacySha256: seed.sha256, legacyBytes: seed.bytes, userPath: r.outcome?.path });
    expect(r.marker?.counts).toEqual(r.outcome?.counts);
    expect(r.files).toEqual([r.outcome?.path]);
    // instrumentation sanity: the one-time USER import is the only place a big buffer legitimately crosses postMessage (<= 16 MiB)
    const stats = await h<{ maxBufferBytes: number }>(page, 'message-stats');
    expect(stats.maxBufferBytes).toBeGreaterThanOrEqual(seed.bytes);
    expect(stats.maxBufferBytes).toBeLessThanOrEqual(16 * MIB);

    const user = await h<UserDump>(page, 'user-dump');
    expect(user.dump).toEqual(seed.dump);
    expect(user.integrity).toEqual([['ok']]);
    expect(user.fk).toEqual([]);
    const installed = user.ops.installed as unknown[][];
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((row) => row[1] === 'absent' && row.slice(2).every((v) => v === null))).toBe(true);
    expect(user.ops.jobs).toEqual([['job-1', 'interrupted', null]]);
    expect(user.ops.sync).toEqual([['sync-1', 'interrupted', null]]);
    expect(user.ops.admission).toEqual([]);

    // the legacy key (and the replaceable catalog key) were only READ
    expect(await h(page, 'idb-snapshot')).toEqual(seed.legacy);

    // reload: marker + valid USER -> existing, nothing duplicated, legacy never replayed
    await page.reload();
    await h(page, 'init');
    const again = await h<EnsureResult>(page, 'ensure-user');
    expect(again.outcome).toEqual({ kind: 'existing', path: r.outcome?.path });
    expect(again.phases).toEqual(['checking']);
    expect((await h<UserDump>(page, 'user-dump')).dump).toEqual(seed.dump);
    expect(await h(page, 'idb-snapshot')).toEqual(seed.legacy);
  });

  test('crash before the role/marker commit: legacy stays authoritative, next boot redoes it with a NEW path and drops the orphan', async ({ page }) => {
    await h(page, 'init');
    const seed = await h<Seed>(page, 'seed-legacy', { extraOwned: 5 });
    const crashed = await h<EnsureResult>(page, 'ensure-user', { failCommit: true });
    expect(crashed.ok).toBe(false);
    expect(crashed.files).toHaveLength(1);
    const orphan = crashed.files[0] as string;
    expect(orphan).toMatch(/^\/user\/m-/);
    await page.reload();
    await h(page, 'init');
    expect((await h<{ role: unknown }>(page, 'roles')).role).toBeNull();
    const redone = await h<EnsureResult>(page, 'ensure-user');
    expect(redone.outcome?.kind).toBe('migrated');
    expect(redone.outcome?.path).not.toBe(orphan);
    expect(redone.files).toEqual([redone.outcome?.path]);
    expect((await h<UserDump>(page, 'user-dump')).dump).toEqual(seed.dump);
    expect(await h(page, 'idb-snapshot')).toEqual(seed.legacy);
  });

  test('no legacy store at all -> fresh USER; the probe does not create a jeep database; reload -> existing', async ({ page }) => {
    await h(page, 'init');
    const r = await h<EnsureResult>(page, 'ensure-user');
    expect(r.outcome?.kind).toBe('fresh');
    expect(r.outcome?.path).toMatch(/^\/user\/u-[a-z0-9]+\.db$/);
    expect(r.marker).toBeNull();
    expect(await h<string[]>(page, 'idb-databases')).not.toContain('jeepSqliteStore');
    await page.reload();
    await h(page, 'init');
    expect((await h<EnsureResult>(page, 'ensure-user')).outcome).toEqual({ kind: 'existing', path: r.outcome?.path });
  });

  test('oversized (> 16 MiB) and corrupt legacy values -> MIGRATION_BLOCKED, no new USER, legacy untouched', async ({ page }) => {
    await h(page, 'init');
    await h(page, 'put-legacy-raw', { size: 16 * MIB + 4096, sqliteHeader: true });
    const big = await h<EnsureResult>(page, 'ensure-user');
    expect(big.error).toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'legacy_too_large' });
    expect(big.files).toEqual([]);
    await h(page, 'put-legacy-raw', { size: 8192 });
    const corrupt = await h<EnsureResult>(page, 'ensure-user');
    expect(corrupt.error).toMatchObject({ code: 'MIGRATION_BLOCKED', reason: 'legacy_corrupt' });
    expect(corrupt.files).toEqual([]);
    expect((await h<{ role: unknown }>(page, 'roles')).role).toBeNull();
  });

  test('import throughput without throttling (20 MB), numbers for the report', async ({ page }) => {
    await h(page, 'init');
    const staged = await h<Staged>(page, 'make-staged-db', { megabytes: 20 });
    const r = await h<ImportOutcome>(page, 'import', { job: staged.job, target: CAT, bytes: staged.bytes, sha256: staged.sha256 });
    console.log('IMPORT-NOTHROTTLE', JSON.stringify({ mbps: staged.bytes / MIB / ((r.result?.ms ?? 1) / 1000), ms: r.result?.ms }));
    expect(r.ok).toBe(true);
    expect(r.result?.maxChunkBytes).toBeLessThanOrEqual(262144);
  });
});

test.describe('worker liveness under one long synchronous statement (S6-01)', () => {
  test.setTimeout(120_000);
  type Liveness = { outcome: { ok: boolean; rows?: unknown[]; error?: { code: string; commitState: string | null } }; elapsedMs: number; terminatedBeforeShutdown: number };

  test('a healthy real worker stepping one statement for many multiples of livenessTimeoutMs is NOT terminated (progress heartbeats), result is correct', async ({ page }) => {
    const r = await h<Liveness>(page, 'long-sql-liveness', { rows: 6_000_000, timeoutMs: 1000, intervalMs: 100 });
    console.log('LONG-SQL', JSON.stringify(r));
    expect(r.elapsedMs).toBeGreaterThan(1500); // the statement outlived the 1 s silence window (the worker cannot answer pings meanwhile)
    expect(r.outcome).toEqual({ ok: true, rows: [[18_000_003_000_000]] });
    expect(r.terminatedBeforeShutdown).toBe(0);
  });

  test('a truly dead worker (no replies, no pings, no progress) is still declared dead by the same policy', async ({ page }) => {
    const r = await h<Liveness>(page, 'long-sql-liveness', { rows: 1000, timeoutMs: 300, intervalMs: 50, silent: true });
    expect(r.outcome.ok).toBe(false);
    expect(r.outcome.error).toMatchObject({ code: 'WORKER_DIED', commitState: 'unknown' });
    expect(r.terminatedBeforeShutdown).toBe(1);
    expect(r.elapsedMs).toBeLessThan(5000);
  });
});
