import type { z } from 'zod';
import type { AppSettings, Language } from '@flashydex/schemas';
import type { DatabaseSet } from '../db/database-set';
import { chunk, placeholders, type Exec } from '../db/sql';
import { ValidationError, type ValidationIssue } from '../errors';
import type { Environment } from '../platform/platform';
import type { Quote } from '../domain/valuation';

export interface ServiceContext {
  databases: DatabaseSet;
  env: Environment;
}

export const CHUNK = 100;

/** Parse through a strict zod schema; failures become ValidationError with sorted `{path,code,message}` issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message
  }));
  throw new ValidationError('Invalid input', issues);
}

export const nameKeyOf = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

/** Empty optional text normalizes to null (DATA-MODEL). */
export const emptyToNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Exclusive upper bound of a literal prefix range: every string that starts with `prefix` is >= prefix and < result. */
export const prefixUpperBound = (prefix: string): string => prefix + '\u{10FFFF}';

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Active manifest ids of a set: `raw_json.cards[].id`, unique, in manifest order. */
export function manifestIds(rawJson: string | null | undefined): string[] {
  const raw = parseJson<{ cards?: Array<{ id?: unknown }> }>(rawJson, {});
  const seen = new Set<string>();
  const out: string[] = [];
  for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
    if (typeof card?.id === 'string' && !seen.has(card.id)) {
      seen.add(card.id);
      out.push(card.id);
    }
  }
  return out;
}

export async function readSettings(q: Exec): Promise<AppSettings> {
  const rows = await q.select<{
    languages: string; followed: string; syncAll: number; hide: number; currency: string; ack: number; ackAt: string | null; onboarded: string | null; updatedAt: string;
  }>(
    {
      languages: 'languages_json', followed: 'sets_followed_json', syncAll: 'sync_all_sets', hide: 'hide_tcg_pocket', currency: 'default_currency',
      ack: 'disclaimer_acknowledged', ackAt: 'disclaimer_acknowledged_at', onboarded: 'onboarding_completed_at', updatedAt: 'updated_at'
    },
    "FROM app_settings WHERE id = 'app'"
  );
  const row = rows[0];
  if (!row) throw new Error('app_settings seed row is missing');
  return {
    languages: parseJson<Language[]>(row.languages, ['en', 'ja']),
    setsFollowed: parseJson<AppSettings['setsFollowed']>(row.followed, []),
    syncAllSets: Number(row.syncAll) === 1,
    hideTcgPocket: Number(row.hide) === 1,
    defaultCurrency: row.currency as AppSettings['defaultCurrency'],
    disclaimerAcknowledged: Number(row.ack) === 1,
    disclaimerAcknowledgedAt: row.ackAt,
    onboardingCompletedAt: row.onboarded,
    updatedAt: row.updatedAt
  };
}

export async function readRevision(q: Exec): Promise<number> {
  return Number((await q.scalar<number>("SELECT collection_revision FROM app_state WHERE id = 'collection'")) ?? 0);
}

/** Exactly once per personal mutation transaction. */
export async function bumpRevision(tx: Exec, now: string): Promise<void> {
  await tx.run("UPDATE app_state SET collection_revision = collection_revision + 1, updated_at = ? WHERE id = 'collection'", [now]);
}

export const identityKey = (language: string, id: string): string => `${language}\u0000${id}`;

type QuoteRow = {
  id: string; catalogCardId: string; language: Language; source: Quote['source']; variant: string; variantDetail: string;
  providerVariantKey: string; currency: Quote['currency']; low: number | null; mid: number | null; high: number | null;
  market: number | null; trend: number | null; sourceUpdatedAt: string | null; capturedAt: string;
};
const QUOTE_COLS = {
  id: 'id', catalogCardId: 'catalog_card_id', language: 'language', source: 'source', variant: 'variant', variantDetail: 'variant_detail',
  providerVariantKey: 'provider_variant_key', currency: 'currency', low: 'low_cents', mid: 'mid_cents', high: 'high_cents',
  market: 'market_cents', trend: 'trend_cents', sourceUpdatedAt: 'source_updated_at', capturedAt: 'captured_at'
} as const;
const toQuote = (r: QuoteRow): Quote => ({
  id: r.id, language: r.language, catalogCardId: r.catalogCardId, source: r.source, variant: r.variant, variantDetail: r.variantDetail,
  providerVariantKey: r.providerVariantKey, currency: r.currency, lowCents: r.low, midCents: r.mid, highCents: r.high, marketCents: r.market,
  trendCents: r.trend, sourceUpdatedAt: r.sourceUpdatedAt, capturedAt: r.capturedAt
});

/**
 * Quotes for catalog identities: catalog_latest_prices (catalog DB) merged with preserved user history (price_snapshots).
 * Two lookups per 100-key chunk and language, language in every key (CATALOG-PACKS join plans).
 */
export async function loadQuotes(ctx: ServiceContext, identities: ReadonlyArray<{ language: Language; id: string }>): Promise<Map<string, Quote[]>> {
  const out = new Map<string, Quote[]>();
  const add = (quote: Quote) => {
    const key = identityKey(quote.language, quote.catalogCardId);
    const list = out.get(key);
    if (list) list.push(quote);
    else out.set(key, [quote]);
  };
  const byLanguage = new Map<Language, string[]>();
  for (const identity of identities) {
    const list = byLanguage.get(identity.language);
    if (list) list.push(identity.id);
    else byLanguage.set(identity.language, [identity.id]);
  }
  for (const [language, ids] of byLanguage) {
    const unique = [...new Set(ids)];
    const catalog = await ctx.databases.catalog(language);
    for (const part of chunk(unique, CHUNK)) {
      if (catalog) {
        const rows = await catalog.select<QuoteRow>(QUOTE_COLS, `FROM catalog_latest_prices WHERE language = ? AND catalog_card_id IN (${placeholders(part.length)})`, [language, ...part]);
        rows.forEach((r) => add(toQuote(r)));
      }
      const history = await ctx.databases.user.select<QuoteRow>(QUOTE_COLS, `FROM price_snapshots WHERE language = ? AND catalog_card_id IN (${placeholders(part.length)})`, [language, ...part]);
      history.forEach((r) => add(toQuote(r)));
    }
  }
  return out;
}

/** series (provider serie.id) per (language,setId) from the catalog; absent catalog / unknown set = undefined (never guessed). */
export async function loadSeries(ctx: ServiceContext, sets: ReadonlyArray<{ language: Language; setId: string }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const byLanguage = new Map<Language, Set<string>>();
  for (const s of sets) {
    const set = byLanguage.get(s.language) ?? new Set<string>();
    set.add(s.setId);
    byLanguage.set(s.language, set);
  }
  for (const [language, ids] of byLanguage) {
    const catalog = await ctx.databases.catalog(language);
    if (!catalog) continue;
    for (const part of chunk([...ids], CHUNK)) {
      const rows = await catalog.rows(`SELECT id, series FROM catalog_sets WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part]);
      for (const row of rows) out.set(identityKey(language, String(row[0])), row[1] === null ? null : String(row[1]));
    }
  }
  return out;
}

/** Upstream official card count per (language,setId) from the installed catalog; absent catalog / set / count = no entry (null at the edge). */
export async function loadOfficialCounts(ctx: ServiceContext, sets: ReadonlyArray<{ language: Language; setId: string }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byLanguage = new Map<Language, Set<string>>();
  for (const s of sets) {
    const ids = byLanguage.get(s.language) ?? new Set<string>();
    ids.add(s.setId);
    byLanguage.set(s.language, ids);
  }
  for (const [language, ids] of byLanguage) {
    let catalog;
    try {
      catalog = await ctx.databases.catalog(language);
    } catch {
      continue;
    }
    if (!catalog) continue;
    for (const part of chunk([...ids], CHUNK)) {
      const rows = await catalog.rows(`SELECT id, official_count FROM catalog_sets WHERE language = ? AND id IN (${placeholders(part.length)})`, [language, ...part]);
      for (const row of rows) if (row[1] !== null && row[1] !== undefined) out.set(identityKey(language, String(row[0])), Number(row[1]));
    }
  }
  return out;
}
