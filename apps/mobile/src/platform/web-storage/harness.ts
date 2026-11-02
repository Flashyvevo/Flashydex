/**
 * DEV-only Playwright harness for Stage F web install (`/harness.html` + `await import('/src/platform/web-storage/harness.ts')`).
 * It does NOT boot the app. Part 1: the OPFS stage worker on its own (no sahpool needed). Part 2 (below): the real web install port
 * through the unchanged core services over A's client.
 */
import { newJobId, removeStagingJob, listStagingJobs, runOpfsStage, type StageDone } from './opfs-staging';
import { STAGING_ROOT } from './contract';
import type { StageFaults } from '../pack-install/opfs-stage-protocol';

export interface ManifestEntry {
  targetVersion: string;
  fullPackUrl: string;
  sha256: string;
  compressedSha256?: string;
  compressedBytes: number;
  uncompressedBytes: number;
  counts: Record<string, number>;
}

export async function loadEntry(manifestUrl: string, language: 'en' | 'ja'): Promise<ManifestEntry> {
  const manifest = (await (await fetch(manifestUrl, { cache: 'no-store' })).json()) as { languages: Record<string, ManifestEntry> };
  const entry = manifest.languages[language];
  if (!entry) throw new Error(`manifest has no ${language}`);
  return entry;
}

interface HeapSampler { stop(): { peak: number; samples: number } }
export function sampleHeap(intervalMs = 50): HeapSampler {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  let peak = 0;
  let samples = 0;
  const read = () => {
    if (!memory) return;
    peak = Math.max(peak, memory.usedJSHeapSize);
    samples += 1;
  };
  read();
  const timer = setInterval(read, intervalMs);
  return { stop: () => { clearInterval(timer); read(); return { peak, samples }; } };
}

export async function stagingListing(): Promise<{ job: string; files: { name: string; size: number }[] }[]> {
  const root = await navigator.storage.getDirectory();
  let staging: FileSystemDirectoryHandle;
  try {
    staging = await root.getDirectoryHandle(STAGING_ROOT);
  } catch {
    return [];
  }
  const out: { job: string; files: { name: string; size: number }[] }[] = [];
  for (const job of await listStagingJobs()) {
    const dir = await staging.getDirectoryHandle(job);
    const files: { name: string; size: number }[] = [];
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'file') files.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
    }
    out.push({ job, files });
  }
  return out;
}

export async function clearStaging(): Promise<void> {
  for (const job of await listStagingJobs()) await removeStagingJob(job);
}

export type StageOnlyResult =
  | { ok: true; done: StageDone; ms: number; heapPeak: number; heapSamples: number; staged: { job: string; files: { name: string; size: number }[] }[] }
  | { ok: false; code: string; message: string; heapPeak: number; staged: { job: string; files: { name: string; size: number }[] }[] };

/** Runs ONLY the OPFS stage worker (download -> staged compressed file -> bounded decode -> staged raw file). */
export async function stageOnly(options: { manifestUrl: string; language: 'en' | 'ja'; fault?: StageFaults; corrupt?: 'sha' | 'size' | 'compressedSha' | 'origin'; keep?: boolean; abortAfterMs?: number }): Promise<StageOnlyResult> {
  const entry = await loadEntry(options.manifestUrl, options.language);
  const job = newJobId();
  const sampler = sampleHeap(50);
  const controller = new AbortController();
  if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
  const started = performance.now();
  try {
    const done = await runOpfsStage({
      job,
      url: new URL(entry.fullPackUrl, window.location.origin).toString(),
      trustedOrigins: options.corrupt === 'origin' ? ['https://example.invalid'] : [window.location.origin],
      expectedCompressedBytes: entry.compressedBytes + (options.corrupt === 'size' ? 1 : 0),
      expectedUncompressedBytes: entry.uncompressedBytes,
      compressedSha256: options.corrupt === 'compressedSha' ? '0'.repeat(64) : entry.compressedSha256,
      expectedSha256: options.corrupt === 'sha' ? '0'.repeat(64) : entry.sha256,
      fault: options.fault,
      signal: controller.signal
    });
    const heap = sampler.stop();
    const staged = await stagingListing();
    if (!options.keep) await removeStagingJob(job);
    return { ok: true, done, ms: Math.round(performance.now() - started), heapPeak: heap.peak, heapSamples: heap.samples, staged };
  } catch (error) {
    const heap = sampler.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const staged = await stagingListing();
    const e = error as { code?: string; message?: string };
    return { ok: false, code: e.code ?? 'UNKNOWN', message: e.message ?? String(error), heapPeak: heap.peak, staged };
  }
}

/* ──────────────────────────────────────────────── Part 2: the real web install port through UNCHANGED core services ──────────────────────────────────────────────── */
import type { Services } from '@flashydex/core';

interface CoreWorld { services: Services; manifestUrl: { current: string } }
let world: CoreWorld | null = null;

/**
 * Boots exactly what bootstrap does (prepareStorage -> createUserDriver -> core createServices) but with a swappable manifest URL.
 * Idempotent per page. Progress events are pushed to `window.__fdxProgress` so specs can kill the page at a known phase.
 */
export async function bootCore(manifestUrl: string): Promise<{ boot: Awaited<ReturnType<typeof import('../app-database').prepareStorage>>['kind'] }> {
  if (world) { world.manifestUrl.current = manifestUrl; return { boot: 'web' }; }
  const [{ prepareStorage, createUserDriver, catalogSource, createInstallPort }, { createServices }, { catalogConfig }, { platform }, { fetchManifestText }] = await Promise.all([
    import('../app-database'), import('@flashydex/core'), import('../catalog-config'), import('../app-platform'), import('../pack-install')
  ]);
  const holder = { current: manifestUrl };
  const prepared = await prepareStorage();
  const userDriver = await createUserDriver();
  const port = createInstallPort();
  const wrapped = Object.create(port) as typeof port;
  wrapped.fetchManifest = (input, signal) => fetchManifestText({ maxBytes: Math.min(input.maxBytes, 256 * 1024), url: holder.current }, signal);
  const services = await createServices({
    userDriver, catalogSource,
    env: { clock: { now: () => new Date().toISOString() }, ids: { uuid: () => crypto.randomUUID() } },
    installPort: wrapped, platform, appVersion: '0.1.0', catalog: { ...catalogConfig(), manifestUrl }
  });
  // Spec seam: `window.__fdxKeepPrevious = true` makes discardPrevious a no-op so the rollback path is reachable through core.
  const realDiscard = port.discardPrevious.bind(port);
  wrapped.discardPrevious = (language) => ((window as unknown as { __fdxKeepPrevious?: boolean }).__fdxKeepPrevious ? Promise.resolve() : realDiscard(language));
  world = { services, manifestUrl: holder };
  return { boot: prepared.kind };
}

const core = (): CoreWorld => { if (!world) throw new Error('bootCore first'); return world; };

export interface PhaseSnapshot { phase: string; active: string | null; previous: string | null; files: string[] }
export interface CoreInstallResult {
  ok: boolean; code?: string; message?: string;
  receipt?: unknown; totalMs: number; phases: Record<string, number>; heapPeak: number; heapSamples: number; snapshots: PhaseSnapshot[];
}

export async function installThroughCore(options: { language?: 'en' | 'ja'; manifestUrl?: string; abortAfterMs?: number; snapshotPhases?: boolean } = {}): Promise<CoreInstallResult> {
  const w = core();
  if (options.manifestUrl) w.manifestUrl.current = options.manifestUrl;
  const language = options.language ?? 'en';
  const log: { phase: string; done: number; at: number }[] = [];
  const seenPhases = new Set<string>();
  const snapshots: Promise<PhaseSnapshot>[] = [];
  (window as unknown as { __fdxProgress: unknown }).__fdxProgress = log;
  performance.clearMeasures();
  const sampler = sampleHeap(50);
  const controller = new AbortController();
  if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
  const started = performance.now();
  let out: Pick<CoreInstallResult, 'ok' | 'code' | 'message' | 'receipt'>;
  try {
    const receipt = await w.services.install.install(language, (p) => {
      const q = p as unknown as { phase: string; decompressedBytesDone?: number; decodedBytes?: number };
      log.push({ phase: q.phase, done: q.decompressedBytesDone ?? q.decodedBytes ?? 0, at: Math.round(performance.now()) });
      if (options.snapshotPhases && !seenPhases.has(q.phase)) {
        seenPhases.add(q.phase);
        snapshots.push(poolState().then((s) => ({ phase: q.phase, active: (s.roles as Record<string, { activeRef: string | null }>)[language]!.activeRef, previous: (s.roles as Record<string, { previousRef: string | null }>)[language]!.previousRef, files: s.files })));
      }
    }, controller.signal);
    out = { ok: true, receipt };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    out = { ok: false, code: e.code ?? 'UNKNOWN', message: e.message ?? String(error) };
  }
  const heap = sampler.stop();
  const phases: Record<string, number> = {};
  for (const m of performance.getEntriesByType('measure')) if (m.name.startsWith('fdx:pack-')) phases[m.name.slice(9)] = Math.round(m.duration);
  return { ...out, totalMs: Math.round(performance.now() - started), phases, heapPeak: heap.peak, heapSamples: heap.samples, snapshots: await Promise.all(snapshots) };
}

/** Fire-and-forget install (the spec kills the page while it runs). Resolves when started. */
export function startInstall(options: { language?: 'en' | 'ja'; manifestUrl?: string } = {}): void {
  void installThroughCore(options);
}

export async function searchCore(q: string, language: 'en' | 'ja' = 'en'): Promise<{ total: number; names: string[] }> {
  const page = await core().services.catalog.searchCards({ q, language, limit: 5 } as never);
  return { total: page.page.total, names: page.data.map((c) => (c as unknown as { name: string }).name) };
}

export async function coreReceipt(language: 'en' | 'ja' = 'en'): Promise<unknown> {
  return core().services.install.installed(language);
}

export async function rollbackCore(language: 'en' | 'ja' = 'en'): Promise<{ ok: boolean; code?: string; receipt?: unknown }> {
  try { return { ok: true, receipt: await core().services.install.rollback(language) }; } catch (error) { return { ok: false, code: (error as { code?: string }).code ?? 'UNKNOWN' }; }
}

export async function uninstallCore(language: 'en' | 'ja' = 'en'): Promise<void> {
  await core().services.install.uninstall({ language, confirm: true } as never);
}

export async function poolState(): Promise<{ files: string[]; roles: unknown; staging: string[]; usage: number | null }> {
  const [{ getWebSqliteClient }, { getRoleStore }] = await Promise.all([import('../web-sqlite'), import('./role-store')]);
  const files = (await getWebSqliteClient().listFiles()).map(String).sort();
  const roles = (await getRoleStore().load()).languages;
  const est = await navigator.storage.estimate();
  return { files, roles, staging: await listStagingJobs(), usage: est.usage ?? null };
}
