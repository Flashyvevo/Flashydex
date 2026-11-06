import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PackInstallError, fetchManifestText, getCatalogStorage, getWebCatalogStorage, manifestUrl, removeCatalog, stageCatalogPack,
  type CatalogLanguageCode, type PackEntryInput, type StageProgress, type StageResult
} from '../../platform/pack-install';
import { catalogConfig } from '../../platform/catalog-config';
import { LANGUAGE_BADGE } from '../../lib/format';

type CatalogPackEntry = PackEntryInput;
type InstallResult = StageResult & { previousRef: string | null };

/** Dev harness: language entries of the dev manifest, in en, ja order (core's semantic validation is NOT applied here). */
function manifestEntries(manifest: { languages?: Partial<Record<CatalogLanguageCode, Omit<PackEntryInput, 'language'>>> }): CatalogPackEntry[] {
  return (['en', 'ja'] as const).flatMap((language) => {
    const entry = manifest.languages?.[language];
    return entry ? [{ ...entry, language }] : [];
  });
}

/**
 * DEV-ONLY pack install harness. Rendered only when `import.meta.env.DEV`; production builds render a not-found.
 * Installs a pack from the dev manifest (/dev-packs/catalog-manifest.json), opens it read-only, and prints table row counts
 * (data-testids are the contract for apps/mobile/e2e/pack-install.spec.ts).
 */
const COUNT_TABLES = ['catalog_sets', 'catalog_cards', 'catalog_variants', 'catalog_latest_prices'] as const;

type Status = 'idle' | 'loading-manifest' | 'ready' | 'downloading' | 'verifying' | 'validating' | 'activating' | 'installed' | 'error' | 'cancelled';

interface PoolSnapshot { files: string[]; activeRefs: Record<string, string | null>; previousRefs: Record<string, string | null>; staging: string[] }

/** Catalog pool files + role-store pointers + OPFS staging jobs: what the spec asserts instead of the old jeep IndexedDB keys. */
async function poolSnapshot(): Promise<PoolSnapshot> {
  const [{ getWebSqliteClient }, { getRoleStore }, { listStagingJobs }] = await Promise.all([
    import('../../platform/web-sqlite'), import('../../platform/web-storage/role-store'), import('../../platform/web-storage/opfs-staging')
  ]);
  const files = (await getWebSqliteClient().listFiles()).map(String).filter((f) => f.startsWith('/catalog-')).sort();
  const languages = (await getRoleStore().load()).languages as unknown as Record<string, { activeRef: string | null; previousRef: string | null }>;
  const activeRefs: Record<string, string | null> = {};
  const previousRefs: Record<string, string | null> = {};
  for (const [language, roles] of Object.entries(languages)) { activeRefs[language] = roles.activeRef; previousRefs[language] = roles.previousRef; }
  return { files, activeRefs, previousRefs, staging: await listStagingJobs() };
}

function PackTestPage() {
  const [status, setStatus] = useState<Status>('loading-manifest');
  const [entries, setEntries] = useState<CatalogPackEntry[]>([]);
  const [progress, setProgress] = useState<StageProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [firstCard, setFirstCard] = useState<string | null>(null);
  const [language, setLanguage] = useState<CatalogLanguageCode | null>(null);
  const [beforeFinalize, setBeforeFinalize] = useState<PoolSnapshot | null>(null);
  const [after, setAfter] = useState<PoolSnapshot | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchManifestText({ maxBytes: 256 * 1024 }, controller.signal)
      .then(({ text }) => { setEntries(manifestEntries(JSON.parse(text))); setStatus('ready'); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof PackInstallError ? `${cause.code}: ${cause.message}` : String(cause));
        setStatus('error');
      });
    return () => controller.abort();
  }, []);

  const install = useCallback(async (entry: CatalogPackEntry) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setLanguage(entry.language);
    setError(null);
    setResult(null);
    setCounts(null);
    setFirstCard(null);
    setBeforeFinalize(null);
    setAfter(null);
    setStatus('downloading');
    try {
      const staged = await stageCatalogPack(entry, {
        trustedOrigins: catalogConfig().trustedOrigins,
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p);
          setStatus(p.phase);
        }
      });
      // Harness only: core would validate the candidate here (validateCatalogCandidate) before activating.
      setStatus('activating');
      const storage = getCatalogStorage();
      const activated = await storage.activate(entry.language, staged.candidateRef);
      const installed: InstallResult = { ...staged, previousRef: activated.previousRef };
      // The previous copy must still exist on disk between activate and finalize (discardPrevious); the spec asserts this snapshot.
      setBeforeFinalize(await poolSnapshot());
      await storage.discardPrevious(entry.language);
      const driver = await getWebCatalogStorage().openCatalogDriver(entry.language, 'ro');
      if (!driver) throw new PackInstallError('PACK_INVALID', `No ${entry.language} catalog is installed`);
      const read: Record<string, number> = {};
      for (const table of COUNT_TABLES) {
        const { rows } = await driver.proxy(`SELECT COUNT(*) FROM ${table}`, [], 'values');
        read[table] = Number((rows[0] as unknown[])[0]);
      }
      const card = await driver.proxy('SELECT name, local_id FROM catalog_cards ORDER BY local_id_sort, id LIMIT 1', [], 'values');
      setFirstCard(card.rows.length ? `${(card.rows[0] as unknown[])[1]} ${(card.rows[0] as unknown[])[0]}` : null);
      setAfter(await poolSnapshot());
      setCounts(read);
      setResult(installed);
      setStatus('installed');
    } catch (cause) {
      if (cause instanceof PackInstallError && cause.code === 'CANCELLED') setStatus('cancelled');
      else {
        setError(cause instanceof PackInstallError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, []);

  const busy = status === 'downloading' || status === 'verifying' || status === 'validating' || status === 'activating';

  return (
    <main className="min-h-dvh bg-[#101114] p-4 text-sm text-zinc-100">
      <h1 className="text-xl font-semibold">Pack test (dev only)</h1>
      <p className="mt-1 text-zinc-400">Manifest: <span data-testid="manifest-url">{manifestUrl()}</span></p>
      <p className="mt-2">Status: <strong data-testid="pack-status">{status}</strong></p>
      {error && <p role="alert" data-testid="pack-error" className="mt-2 text-red-400">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {entries.map((entry) => (
          <button key={entry.language} type="button" data-testid={`install-${entry.language}`} disabled={busy}
            className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-40" onClick={() => void install(entry)}>
            Install {LANGUAGE_BADGE[entry.language]} {entry.targetVersion}
          </button>
        ))}
        <button type="button" data-testid="cancel" disabled={!busy} className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-40" onClick={() => abortRef.current?.abort()}>Cancel</button>
        {language && (
          <button type="button" data-testid="remove" disabled={busy} className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-40"
            onClick={() => void getWebCatalogStorage().releaseLanguage(language).then(() => removeCatalog(language)).then(() => { setCounts(null); setResult(null); setStatus('ready'); })}>
            Remove {LANGUAGE_BADGE[language]}
          </button>
        )}
      </div>

      {progress && (
        <p className="mt-3 text-zinc-300" data-testid="pack-progress">
          phase {progress.phase}: compressed {progress.compressedBytesDone}/{progress.compressedBytesTotal} B, decoded {progress.decompressedBytesDone}/{progress.decompressedBytesTotal} B
        </p>
      )}

      {result && (
        <dl className="mt-3 space-y-1 break-all text-zinc-300">
          <div>language <span data-testid="pack-language">{result.language}</span></div>
          <div>version <span data-testid="pack-version">{result.version}</span></div>
          <div>bytes <span data-testid="pack-bytes">{result.bytes}</span></div>
          <div>sha256 <span data-testid="pack-sha256">{result.sha256}</span></div>
          <div>previous kept <span data-testid="pack-previous">{String(result.previousRef !== null)}</span></div>
          <div>metrics <code data-testid="pack-metrics">{JSON.stringify(result.metrics)}</code></div>
        </dl>
      )}

      {beforeFinalize && <code className="hidden" data-testid="pool-before-finalize">{JSON.stringify(beforeFinalize)}</code>}
      {after && <code className="hidden" data-testid="pool-after">{JSON.stringify(after)}</code>}

      {counts && (
        <ul className="mt-3 space-y-1">
          {COUNT_TABLES.map((table) => (
            <li key={table}>{table}: <span data-testid={`count-${table}`}>{counts[table]}</span></li>
          ))}
          <li>first card: <span data-testid="first-card">{firstCard}</span></li>
        </ul>
      )}
    </main>
  );
}

function NotFound() {
  return (
    <main className="p-6 text-zinc-300">
      <h1 className="text-lg font-semibold">Not found</h1>
    </main>
  );
}

export const Route = createFileRoute('/dev/pack-test')({
  component: () => (import.meta.env.DEV ? <PackTestPage /> : <NotFound />)
});
