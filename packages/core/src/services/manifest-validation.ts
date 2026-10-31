import { createCatalogManifestSchema, type CatalogManifest, type InstalledCatalog } from '@flashydex/schemas';
import { CatalogError } from '../errors';

export const MANIFEST_MAX_BYTES = 256 * 1024;
const MAX_COMPRESSED = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED = 512 * 1024 * 1024;

export interface ManifestContext {
  requestedUrl: string;
  finalUrl: string;
  /** Origins (`https://host[:port]`) the manifest and every pack/set-index URL must live on. */
  trustedOrigins: readonly string[];
  allowDevUrls: boolean;
  installed: ReadonlyArray<Pick<InstalledCatalog, 'language' | 'version' | 'sha256' | 'status'>>;
}

const VERSION = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})\.([0-9]{3})$/;

/** `YYYY.MM.DD.NNN`: a real calendar date and NNN >= 001. */
export function isCalendarVersion(version: string): boolean {
  const m = VERSION.exec(version);
  if (!m) return false;
  const [y, mo, d, n] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (n < 1) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Fixed-width, so lexical order is chronological order. */
export const compareVersions = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const invalid = (message: string): CatalogError => new CatalogError('MANIFEST_INVALID', message);

function originOf(url: string, base: string | null): string | null {
  try {
    return new URL(url, base ?? undefined).origin;
  } catch {
    return null;
  }
}

/** Bounded text -> JSON. Core rejects text over 256 KiB too (the adapter streams and stops earlier). */
export function parseManifestText(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MANIFEST_MAX_BYTES) throw new CatalogError('PAYLOAD_TOO_LARGE', 'The catalog manifest is too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid('The catalog manifest is not valid JSON');
  }
}

/**
 * R09 / D46: central semantic validation. Unsigned Phase 1 manifests are accepted; a PRESENT signature is rejected because no keys
 * are shipped (an ignored invalid signature must never look verified).
 */
export function validateManifestSemantics(raw: unknown, ctx: ManifestContext): CatalogManifest {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>).signature !== undefined) {
    throw new CatalogError('MANIFEST_SIGNATURE_INVALID', 'The catalog manifest carries a signature this app cannot verify');
  }
  const parsed = createCatalogManifestSchema({ allowDevUrls: ctx.allowDevUrls }).safeParse(raw);
  if (!parsed.success) throw invalid('The catalog manifest is not valid');
  const manifest = parsed.data;

  const trusted = new Set(ctx.trustedOrigins.map((o) => originOf(o, null) ?? o));
  if (ctx.allowDevUrls) {
    for (const url of [ctx.requestedUrl, ctx.finalUrl]) {
      const o = originOf(url, null);
      if (o) trusted.add(o);
    }
  }
  const secure = (url: string) => {
    try {
      const u = new URL(url, ctx.finalUrl);
      return u.protocol === 'https:' || (ctx.allowDevUrls && u.protocol === 'http:');
    } catch {
      return false;
    }
  };
  const mustBeTrusted = (url: string, what: string) => {
    const origin = originOf(url, ctx.finalUrl);
    if (!origin || !secure(url)) throw invalid(`${what} must use https`);
    if (!trusted.has(origin)) throw invalid(`${what} is not on a trusted origin`);
  };
  mustBeTrusted(ctx.requestedUrl, 'The manifest URL');
  mustBeTrusted(ctx.finalUrl, 'The manifest redirect target');

  if (!isCalendarVersion(manifest.targetVersion)) throw invalid('The manifest version is not a valid date version');
  if (manifest.currentVersion !== null && !isCalendarVersion(manifest.currentVersion)) throw invalid('The manifest current version is not a valid date version');

  for (const language of ['en', 'ja'] as const) {
    const entry = manifest.languages[language];
    if (!entry) continue;
    if (!isCalendarVersion(entry.targetVersion)) throw invalid(`The ${language} catalog version is not a valid date version`);
    if (entry.currentVersion !== null && !isCalendarVersion(entry.currentVersion)) throw invalid(`The ${language} current version is not a valid date version`);
    if (compareVersions(entry.targetVersion, manifest.targetVersion) > 0) throw invalid(`The ${language} catalog is newer than its manifest`);
    mustBeTrusted(entry.fullPackUrl, `The ${language} pack URL`);
    if (entry.setIndexUrl) mustBeTrusted(entry.setIndexUrl, `The ${language} set index URL`);
    if (entry.delta) {
      mustBeTrusted(entry.delta.url, `The ${language} delta URL`);
      if (!isCalendarVersion(entry.delta.currentVersion) || !isCalendarVersion(entry.delta.targetVersion)) throw invalid('The delta version is not a valid date version');
    }
    if (entry.compressedBytes > MAX_COMPRESSED || entry.uncompressedBytes > MAX_UNCOMPRESSED) throw invalid(`The ${language} catalog exceeds the supported size`);
    const c = entry.counts;
    if (c.unpublishedSets > c.sets) throw invalid(`The ${language} catalog counts are inconsistent`);
    if (c.cards > 0 && c.sets === c.unpublishedSets) throw invalid(`The ${language} catalog has cards but no published set`);
    if (c.variants > 0 && c.cards === 0) throw invalid(`The ${language} catalog has variants but no cards`);
    if (c.prices > 0 && c.cards === 0) throw invalid(`The ${language} catalog has prices but no cards`);

    const installed = ctx.installed.find((i) => i.language === language);
    if (installed && installed.status === 'installed' && installed.version) {
      const order = compareVersions(entry.targetVersion, installed.version);
      if (order < 0) throw invalid(`The ${language} catalog on offer is older than the installed one`);
      if (order === 0 && installed.sha256 !== null && installed.sha256 !== entry.sha256) throw invalid(`The ${language} catalog version was republished with different content`);
    }
  }
  return manifest;
}
