import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { CATALOG_SCHEMA_VERSION } from '@flashydex/core/catalog-schema';
import { mapSetIndexEntry, symbolUrl, type CatalogLanguage, type CatalogSetIndexEntry } from '@flashydex/core/catalog/tcgdex';
import { buildCatalogDb, verifyCatalogDb } from './build-db';
import { checkAssetUrls, crawl } from './crawl';
import { Fetcher } from './http';
import { mergeManifest, readExistingManifest, validateManifest, type CatalogManifest, type ManifestEntry } from './manifest';
import { loadCatalogMigrations, schemaFingerprint } from './migrations';
import { TCGDEX_API } from './crawl';
import { resolveSetArt } from './set-art';
import { assertResumeCompatible, cacheConfigHash, commitImmutableArtifact, gitContentIdentity, hashSetIds, type RunBinding } from './run-guard';
import { MAX_WINDOW_BYTES, ZSTD_LEVEL, compressFile, decompressFile, fileSize, sha256File } from './zstd';

const BUILDER_NAME = 'flashydex-catalog-builder';
const BUILDER_PACKAGE_VERSION = '0.1.0';
const ZSTD_LIBRARY_ID = 'zstd-napi@0.0.13';
const DEFAULT_REPO = 'https://github.com/Flashyvevo/Flashydex';

interface Options {
  language: CatalogLanguage;
  sets?: string[];
  outDir: string;
  version: string;
  resume: boolean;
  cacheDir: string;
  baseUrl: string;
  concurrency: number;
  maxCacheAgeHours: number;
  checkAssets: boolean;
}

const log = (message: string) => process.stderr.write(`[catalog-builder] ${message}\n`);

function usage(): never {
  process.stderr.write(`Usage: npm run catalog:build -- --lang en|ja [--sets swsh3,sv1] [--out dist/] [--version YYYY.MM.DD.NNN] [--resume]
       [--cache-dir .cache] [--base-url <release download url>] [--concurrency 8] [--max-cache-age-hours 24] [--no-asset-check]
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) usage();
    const name = arg.slice(2);
    if (['resume', 'no-asset-check', 'help'].includes(name)) flags.set(name, true);
    else {
      const value = argv[++i];
      if (value === undefined) usage();
      flags.set(name, value);
    }
  }
  if (flags.has('help')) usage();
  const lang = flags.get('lang');
  if (lang !== 'en' && lang !== 'ja') usage();
  const today = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
  const version = typeof flags.get('version') === 'string' ? (flags.get('version') as string) : `${today}.001`;
  if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/.test(version)) throw new Error(`--version must be YYYY.MM.DD.NNN, got ${version}`);
  const sets = typeof flags.get('sets') === 'string' ? (flags.get('sets') as string).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  if (flags.has('sets') && !sets?.length) usage();
  const concurrency = Number(flags.get('concurrency') ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error(`--concurrency must be an integer from 1 to 8, got ${String(flags.get('concurrency') ?? 8)}`);
  }
  return {
    language: lang,
    sets,
    outDir: resolve(typeof flags.get('out') === 'string' ? (flags.get('out') as string) : 'dist'),
    version,
    resume: flags.has('resume'),
    cacheDir: resolve(typeof flags.get('cache-dir') === 'string' ? (flags.get('cache-dir') as string) : '.cache'),
    baseUrl: (typeof flags.get('base-url') === 'string' ? (flags.get('base-url') as string) : `${DEFAULT_REPO}/releases/download/catalog-v${version}`).replace(/\/$/, ''),
    concurrency,
    maxCacheAgeHours: Number(flags.get('max-cache-age-hours') ?? 24),
    checkAssets: !flags.has('no-asset-check')
  };
}

function gitContentId(): string {
  const run = (args: string[], cwd?: string) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, ...(cwd ? { cwd } : {}) });
  try {
    const root = run(['rev-parse', '--show-toplevel']).trim();
    return gitContentIdentity((args) => run(args, root));
  } catch { return 'nogit'; }
}

function startRssSampler(): () => number {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  timer.unref();
  return () => {
    clearInterval(timer);
    const kernelMax = typeof process.resourceUsage === 'function' ? process.resourceUsage().maxRSS * 1024 : 0;
    return Math.max(peak, process.memoryUsage().rss, kernelMax);
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.part`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

interface RunFile { runId: string; builtAt: string; version: string; language: CatalogLanguage; binding?: RunBinding; selectedSetIdsHash?: string }

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const stopRss = startRssSampler();
  const { language, version, outDir } = options;
  await mkdir(outDir, { recursive: true });

  // 1. Freeze run id / UTC cutoff (a resumed run keeps the original ones).
  const runPath = join(options.cacheDir, language, 'run.json');
  const migrations = loadCatalogMigrations();
  const fingerprint = schemaFingerprint(migrations);
  const builderGit = gitContentId();
  const binding: RunBinding = {
    setSelectionHash: hashSetIds(options.sets),
    schemaVersion: CATALOG_SCHEMA_VERSION,
    schemaFingerprint: fingerprint,
    nodeVersion: process.version,
    builderPackageVersion: BUILDER_PACKAGE_VERSION,
    builderGit,
    zstdLibrary: ZSTD_LIBRARY_ID,
    apiBase: TCGDEX_API
  };
  let run: RunFile | null = null;
  if (options.resume) {
    try {
      const existing = JSON.parse(await readFile(runPath, 'utf8')) as RunFile;
      if (existing.version === version) run = existing;
    } catch { /* no previous run */ }
    if (run) assertResumeCompatible(run.binding, binding);
  }
  run ??= { runId: randomUUID(), builtAt: new Date().toISOString(), version, language, binding };
  await writeJson(runPath, run);
  const builderVersion = `${BUILDER_NAME}@${BUILDER_PACKAGE_VERSION}+${builderGit.slice(0, 7)}${builderGit.includes('+dirty') ? '-dirty' : ''}`;
  log(`run ${run.runId} ${language} ${version} cutoff ${run.builtAt}${options.resume ? ' (resume)' : ''}`);

  // 2-3. Crawl (cached on disk, resumable).
  const fetcher = new Fetcher({
    concurrency: options.concurrency,
    maxCacheAgeMs: options.resume ? Number.POSITIVE_INFINITY : options.maxCacheAgeHours * 3600 * 1000,
    cacheConfig: cacheConfigHash(language, TCGDEX_API),
    runId: run.runId, // R11: cache entries are reused only by the run that wrote them (a resume), never across runs
    onLog: log
  });
  const crawlStarted = performance.now();
  const crawled = await crawl(fetcher, { language, sets: options.sets, cacheRoot: options.cacheDir, discoveryMaxAgeMs: options.resume ? undefined : 0, log });
  const symbolUrls = [...crawled.details.values()].map((d) => symbolUrl(d.symbol, language)).filter((u): u is string => u !== null);
  const missingAssets = options.checkAssets ? await checkAssetUrls(fetcher, symbolUrls, crawled.warnings) : new Set<string>();
  // Logo fallbacks (alternate TCGdex files -> JA->EN twin -> symbol), each only after an HTTP 200 probe. Skipped with --no-asset-check.
  const setArt = options.checkAssets && crawled.failures.length === 0
    ? await resolveSetArt({ language, details: crawled.details, selectedSetIds: crawled.selectedSetIds, fetcher, warnings: crawled.warnings })
    : undefined;
  const crawlMs = Math.round(performance.now() - crawlStarted);
  if (crawled.failures.length) {
    for (const failure of crawled.failures.slice(0, 20)) log(`FAILED ${failure.unit}: ${failure.error}`);
    throw new Error(`${crawled.failures.length} crawl unit(s) failed; refusing to publish an incomplete pack (rerun with --resume)`);
  }
  for (const warning of crawled.warnings) log(`warning: ${warning}`);

  const selectedHash = hashSetIds(crawled.selectedSetIds);
  if (options.resume && run.selectedSetIdsHash && run.selectedSetIdsHash !== selectedHash) {
    throw new Error(`--resume refused: resolved set selection changed since the original run (${run.selectedSetIdsHash} -> ${selectedHash})`);
  }
  run.selectedSetIdsHash = selectedHash;
  await writeJson(runPath, run);

  // Bootstrap set index (ALL sets of the language, shells included).
  const index: CatalogSetIndexEntry[] = crawled.list.map((brief) => {
    const entry = mapSetIndexEntry(crawled.details.get(brief.id)!, { language, syncedAt: run.builtAt });
    if (entry.symbolUrl && missingAssets.has(entry.symbolUrl)) entry.symbolUrl = null;
    const art = setArt?.get(entry.id);
    if (art) entry.logoUrl = art.logoUrl; // unselected sets (--sets subset) keep their native logo
    return entry;
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const setIndexPath = join(outDir, `set-index-${language}.json`);
  await writeJson(setIndexPath, index);

  // 4-5. Build, verify, hash, compress, round-trip.
  const dbPath = join(outDir, `catalog-${language}-${version}.db`);
  const zstPath = `${dbPath}.zst`;
  const buildStarted = performance.now();
  const built = buildCatalogDb(`${dbPath}.part`, {
    language, version, builtAt: run.builtAt, cutoffAt: run.builtAt, builderVersion, details: crawled.details,
    selectedSetIds: crawled.selectedSetIds, cards: crawled.cards, missingAssets, setArt, migrations
  });
  const verified = verifyCatalogDb(`${dbPath}.part`, { language, version, counts: built.counts, fingerprint });
  const buildMs = Math.round(performance.now() - buildStarted);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (await fileSize(`${dbPath}.part${suffix}`).then(() => true, () => false)) throw new Error(`Unexpected sidecar ${dbPath}${suffix}`);
  }
  log(`db artifact: ${await commitImmutableArtifact(`${dbPath}.part`, dbPath)}`);
  const raw = await sha256File(dbPath);
  log(`built ${dbPath}: ${raw.bytes} bytes sha256 ${raw.sha256}`);

  const compressStarted = performance.now();
  await compressFile(dbPath, `${zstPath}.part`, ZSTD_LEVEL);
  log(`pack artifact: ${await commitImmutableArtifact(`${zstPath}.part`, zstPath)}`);
  const compressMs = Math.round(performance.now() - compressStarted);
  const compressed = await sha256File(zstPath);

  const verifyStarted = performance.now();
  const roundTripPath = `${dbPath}.roundtrip.part`;
  const roundTrip = await decompressFile(zstPath, roundTripPath);
  if (roundTrip.windowBytes > MAX_WINDOW_BYTES) throw new Error(`zstd window ${roundTrip.windowBytes} exceeds the device decoder limit ${MAX_WINDOW_BYTES}`);
  if (roundTrip.bytes !== raw.bytes || roundTrip.sha256 !== raw.sha256) throw new Error('Round-trip decompression does not reproduce the database bytes');
  verifyCatalogDb(roundTripPath, { language, version, counts: built.counts, fingerprint });
  await rm(roundTripPath, { force: true });
  const verifyMs = Math.round(performance.now() - verifyStarted);
  log(`compressed ${compressed.bytes} bytes (ratio ${(raw.bytes / compressed.bytes).toFixed(2)}), round-trip OK`);

  // 6. Manifest + metrics.
  const entry: ManifestEntry = {
    currentVersion: null,
    targetVersion: version,
    fullPackUrl: `${options.baseUrl}/catalog-${language}-${version}.db.zst`,
    setIndexUrl: `${options.baseUrl}/set-index-${language}.json`,
    compressedBytes: compressed.bytes,
    uncompressedBytes: raw.bytes,
    sha256: raw.sha256,
    compressedSha256: compressed.sha256,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    builtAt: run.builtAt,
    counts: built.counts
  };
  const manifestPath = join(outDir, 'catalog-manifest.json');
  const manifest: CatalogManifest = mergeManifest(await readExistingManifest(manifestPath), language, entry);
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error(`Manifest validation failed:\n- ${problems.join('\n- ')}`);
  await writeJson(manifestPath, manifest);

  const peakRssBytes = stopRss();
  const sqliteVersion = new Database(':memory:').prepare('select sqlite_version() as v').pluck().get() as string;
  const metrics = {
    metricsVersion: 1,
    runId: run.runId,
    status: 'ok',
    language,
    version,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    sha256: raw.sha256,
    compressedSha256: compressed.sha256,
    compressedBytes: compressed.bytes,
    uncompressedBytes: raw.bytes,
    compressionRatio: Number((raw.bytes / compressed.bytes).toFixed(4)),
    savingsPercent: Number((100 * (1 - compressed.bytes / raw.bytes)).toFixed(2)),
    crawlMs,
    buildMs,
    compressMs,
    decompressMs: roundTrip.ms,
    verifyMs,
    downloadMs: null,
    peakMemoryBytes: peakRssBytes,
    installedFootprintBytes: raw.bytes,
    counts: built.counts,
    setLogoCoverage: built.setLogoCoverage,
    crawl: { ...fetcher.stats, finalConcurrency: fetcher.currentConcurrency, selectedSets: crawled.selectedSetIds.length, totalSetsInLanguage: crawled.list.length },
    sets: options.sets ?? null,
    warnings: [...crawled.warnings, ...built.warnings],
    unavailable: {
      downloadMs: 'NOT_PUBLISHED',
      peakMemoryBytes_attribution: 'builder process peak RSS (zstd-napi and better-sqlite3 run in-process; no decode subprocess)'
    },
    toolchain: {
      builder: builderVersion, node: process.version, platform: `${process.platform}-${process.arch}`, sqlite: sqliteVersion,
      zstdLibrary: ZSTD_LIBRARY_ID, zstdLevel: ZSTD_LEVEL, zstdWindowBytes: roundTrip.windowBytes, schemaFingerprint: fingerprint, pageSize: verified.pageSize, journalMode: verified.journalMode
    }
  };
  const metricsPath = join(outDir, `catalog-${language}-${version}.metrics.json`);
  await writeJson(metricsPath, metrics);

  process.stdout.write(`${JSON.stringify({
    ok: true, language, version,
    files: { db: dbPath, pack: zstPath, manifest: manifestPath, metrics: metricsPath, setIndex: setIndexPath },
    manifestEntry: entry, metrics
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[catalog-builder] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
