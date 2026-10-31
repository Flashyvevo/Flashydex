import { readFile } from 'node:fs/promises';
import type { CatalogLanguage } from '@flashydex/core/catalog/tcgdex';
import type { PackCounts } from './build-db';

export interface ManifestEntry {
  currentVersion: string | null;
  targetVersion: string;
  fullPackUrl: string;
  /** Addition (Director S9): bootstrap set index for the first-run picker. Same URL rules as fullPackUrl. */
  setIndexUrl?: string;
  compressedBytes: number;
  uncompressedBytes: number;
  /** SHA-256 of the UNCOMPRESSED, closed SQLite bytes. */
  sha256: string;
  compressedSha256?: string;
  schemaVersion: number;
  builtAt: string;
  counts: PackCounts;
  delta?: unknown;
}

export interface CatalogManifest {
  manifestVersion: 1;
  currentVersion: string | null;
  targetVersion: string;
  builtAt: string;
  languages: Partial<Record<CatalogLanguage, ManifestEntry>>;
  signature?: unknown;
}

const VERSION_RE = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{3}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function realDate(version: string): boolean {
  const [y, m, d] = version.split('.').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export interface ValidateOptions {
  /** Allow same-origin relative and http:// URLs (dev packs only, Director ruling D27). */
  allowDevUrls?: boolean;
}

/** Validates the CATALOG-PACKS JSON Schema (+ setIndexUrl addition) and its runtime cross-field rules. */
export function validateManifest(manifest: CatalogManifest, options: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  const err = (message: string) => errors.push(message);
  const allowedTop = ['manifestVersion', 'currentVersion', 'targetVersion', 'builtAt', 'languages', 'signature'];
  for (const key of Object.keys(manifest)) if (!allowedTop.includes(key)) err(`unknown root property ${key}`);
  if (manifest.manifestVersion !== 1) err('manifestVersion must be 1');
  if (manifest.currentVersion !== null && !VERSION_RE.test(manifest.currentVersion)) err('root currentVersion invalid');
  if (!VERSION_RE.test(manifest.targetVersion) || !realDate(manifest.targetVersion)) err('root targetVersion invalid');
  if (Number.isNaN(Date.parse(manifest.builtAt))) err('root builtAt invalid');
  if (manifest.currentVersion !== null && manifest.currentVersion >= manifest.targetVersion) err('root currentVersion must be < targetVersion');
  const languages = Object.entries(manifest.languages) as Array<[CatalogLanguage, ManifestEntry]>;
  if (languages.length === 0) err('languages must have at least one entry');
  const urls = new Set<string>();
  const urlOk = (url: string) => (options.allowDevUrls ? /^(https?:\/\/|\/)/.test(url) : url.startsWith('https://')) && url.length <= 2048;
  const entryKeys = ['currentVersion', 'targetVersion', 'fullPackUrl', 'setIndexUrl', 'compressedBytes', 'uncompressedBytes', 'sha256', 'compressedSha256', 'schemaVersion', 'builtAt', 'counts', 'delta'];
  for (const [language, entry] of languages) {
    const at = (m: string) => err(`${language}: ${m}`);
    if (language !== 'en' && language !== 'ja') at('unsupported language');
    for (const key of Object.keys(entry)) if (!entryKeys.includes(key)) at(`unknown property ${key}`);
    if (!VERSION_RE.test(entry.targetVersion) || !realDate(entry.targetVersion)) at('targetVersion invalid');
    if (entry.currentVersion !== null && (!VERSION_RE.test(entry.currentVersion) || entry.currentVersion >= entry.targetVersion)) at('currentVersion invalid or >= targetVersion');
    if (entry.targetVersion > manifest.targetVersion) at('targetVersion exceeds root targetVersion');
    if (!urlOk(entry.fullPackUrl)) at('fullPackUrl must be https');
    if (!entry.fullPackUrl.endsWith(`catalog-${language}-${entry.targetVersion}.db.zst`)) at('fullPackUrl suffix must be catalog-<lang>-<version>.db.zst');
    if (entry.setIndexUrl !== undefined && !urlOk(entry.setIndexUrl)) at('setIndexUrl must be https');
    for (const url of [entry.fullPackUrl, entry.setIndexUrl]) {
      if (url === undefined) continue;
      if (urls.has(url)) at(`duplicate URL ${url}`);
      urls.add(url);
    }
    for (const key of ['compressedBytes', 'uncompressedBytes'] as const) if (!Number.isSafeInteger(entry[key]) || entry[key] < 1) at(`${key} must be a positive safe integer`);
    if (!HASH_RE.test(entry.sha256)) at('sha256 invalid');
    if (entry.compressedSha256 !== undefined && !HASH_RE.test(entry.compressedSha256)) at('compressedSha256 invalid');
    if (!Number.isInteger(entry.schemaVersion) || entry.schemaVersion < 1) at('schemaVersion invalid');
    if (Number.isNaN(Date.parse(entry.builtAt))) at('builtAt invalid');
    for (const key of ['sets', 'cards', 'variants', 'prices', 'unpublishedSets'] as const) if (!Number.isInteger(entry.counts?.[key]) || entry.counts[key] < 0) at(`counts.${key} invalid`);
    if (entry.counts && entry.counts.unpublishedSets > entry.counts.sets) at('counts.unpublishedSets exceeds counts.sets');
  }
  return errors;
}

export async function readExistingManifest(path: string): Promise<CatalogManifest | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as CatalogManifest; } catch { return null; }
}

/** Merge a freshly built language entry into an existing manifest (EN/JA are built by separate runs). */
export function mergeManifest(existing: CatalogManifest | null, language: CatalogLanguage, entry: ManifestEntry): CatalogManifest {
  const languages: CatalogManifest['languages'] = { ...(existing?.languages ?? {}), [language]: entry };
  const targets = Object.values(languages).map((e) => e!.targetVersion).sort();
  const builtAts = Object.values(languages).map((e) => e!.builtAt).sort();
  return {
    manifestVersion: 1,
    currentVersion: null,
    targetVersion: targets[targets.length - 1]!,
    builtAt: builtAts[builtAts.length - 1]!,
    languages
  };
}
