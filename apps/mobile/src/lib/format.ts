// UI-only formatters and display rules (UX.md §0, DESIGN-TOKENS §8). No data access here.

export type Currency = 'USD' | 'EUR';
export type Language = 'en' | 'ja';
export type Variant = 'normal' | 'holo' | 'reverse_holo' | 'first_edition' | 'promo_stamped' | 'shadowless' | 'other';
export type Condition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ja: 'Japanese' };
export const LANGUAGE_BADGE: Record<Language, string> = { en: 'EN', ja: 'JP' };

const locale = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';

const currencyFormatters = new Map<string, Intl.NumberFormat>();
function currencyFormatter(currency: Currency): Intl.NumberFormat {
  let f = currencyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: 'currency', currency });
    currencyFormatters.set(currency, f);
  }
  return f;
}

/** Integer cents → "$1.23". `null` → `null` (callers decide what to show; never "$0.00"). */
export function formatMoney(cents: number | null | undefined, currency: Currency): string | null {
  if (cents === null || cents === undefined) return null;
  return currencyFormatter(currency).format(cents / 100);
}

/** Signed gain/loss with U+2212 minus. */
export function formatSigned(cents: number, currency: Currency): { text: string; tone: 'positive' | 'negative' | 'muted' } {
  const abs = currencyFormatter(currency).format(Math.abs(cents) / 100);
  if (cents > 0) return { text: `+${abs}`, tone: 'positive' };
  if (cents < 0) return { text: `\u2212${abs}`, tone: 'negative' };
  return { text: abs, tone: 'muted' };
}

const numberFormatter = new Intl.NumberFormat(locale);
export const formatInt = (n: number): string => numberFormatter.format(n);

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function formatDate(value: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string | null {
  if (!value) return null;
  // DateOnly "2026-10-12" must not shift with timezone.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

export const formatShortDate = (value: string | null | undefined) => formatDate(value, { day: 'numeric', month: 'short' });
export const releaseYear = (value: string | null | undefined): string | null => (value ? value.slice(0, 4) : null);

/** Collector number rule: `official > 0` → "136/189", else "#136" (never "001/000"). */
export function collectorNumber(localId: string | null | undefined, officialCount: number | null | undefined, opts: { hash?: boolean } = {}): string | null {
  if (!localId) return null;
  if (officialCount && officialCount > 0) return `${localId}/${officialCount}`;
  return opts.hash === false ? localId : `#${localId}`;
}

/** Card art URL helper: `{image}/low.webp` or `/high.webp`. Already-suffixed URLs are returned unchanged. */
export function imageUrl(base: string | null | undefined, size: 'low' | 'high'): string | null {
  if (!base) return null;
  if (/\.(webp|png|jpg|jpeg)$/i.test(base)) return base; // custom cards use a direct URL
  return `${base.replace(/\/$/, '')}/${size}.webp`;
}

/** Set logo/symbol URL = base + `.webp` (UX §6.1). */
export function assetWebp(base: string | null | undefined): string | null {
  if (!base) return null;
  return /\.(webp|png|jpg|jpeg|svg)$/i.test(base) ? base : `${base}.webp`;
}

export const VARIANT_LABEL: Record<Variant, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  first_edition: '1st edition',
  promo_stamped: 'Stamp',
  shadowless: 'Shadowless',
  other: 'Other'
};
export const VARIANT_CHIP: Record<Variant, string | null> = {
  normal: null,
  holo: 'Holo',
  reverse_holo: 'Rev',
  first_edition: '1st',
  promo_stamped: 'Stamp',
  shadowless: 'SL',
  other: ''
};
export const VARIANT_PRIORITY: Variant[] = ['normal', 'holo', 'reverse_holo', 'first_edition', 'promo_stamped'];

export function variantLabel(variant: Variant, detail?: string | null): string {
  if (variant === 'other' && detail) return detail;
  if (variant === 'first_edition' && detail && /holo/i.test(detail)) return '1st edition holo';
  return VARIANT_LABEL[variant];
}
export function variantChipText(variant: Variant, detail?: string | null): string | null {
  if (variant === 'other') return detail ? detail.slice(0, 10) : 'Other';
  if (variant === 'first_edition' && detail && /holo/i.test(detail)) return '1st Holo';
  return VARIANT_CHIP[variant];
}

/** Variant preselection by catalog priority (D10 / UX §7.3). */
export function preselectVariant(available: Variant[]): { variant: Variant; listed: boolean } {
  if (available.length === 0) return { variant: 'normal', listed: false };
  if (available.length === 1) return { variant: available[0]!, listed: true };
  for (const v of VARIANT_PRIORITY) if (available.includes(v)) return { variant: v, listed: true };
  return { variant: available[0]!, listed: true };
}

export const CONDITION_ORDER: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];
export const CONDITION_LABEL: Record<Condition | 'unknown', string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
  unknown: 'Condition not set'
};

export type RarityTier = 'common' | 'uncommon' | 'rare' | 'holo' | 'ultra' | 'illustration' | 'secret' | 'promo' | 'unknown';
const RARITY_TABLE: Record<RarityTier, string[]> = {
  common: ['Common', 'One Diamond'],
  uncommon: ['Uncommon', 'Two Diamond'],
  rare: ['Rare', 'Three Diamond', 'Classic Collection'],
  holo: ['Rare Holo', 'Holo Rare', 'Holo Rare V', 'Holo Rare VMAX', 'Holo Rare VSTAR', 'Rare Holo LV.X', 'Rare PRIME', 'LEGEND', 'Double rare', 'Four Diamond', 'Radiant Rare', 'Amazing Rare', 'ACE SPEC Rare'],
  ultra: ['Ultra Rare', 'Triple Rare', 'Full Art Trainer', 'Shiny rare', 'Shiny rare V', 'Shiny rare VMAX', 'Shiny Ultra Rare', 'One Shiny', 'Two Shiny', 'One Star'],
  illustration: ['Illustration rare', 'Special illustration rare', 'Character Rare', 'Character Super Rare', 'Two Star', 'Three Star'],
  secret: ['Secret Rare', 'Hyper rare', 'Mega Hyper Rare', 'Crown', 'Black White Rare', 'Futuristic Rare', 'Pikachu Rare'],
  promo: ['Promo'],
  unknown: []
};
const RARITY_LOOKUP = new Map<string, RarityTier>();
for (const [tier, names] of Object.entries(RARITY_TABLE) as [RarityTier, string[]][]) {
  for (const n of names) RARITY_LOOKUP.set(n.trim().toLowerCase(), tier);
}
export function rarityTier(rarity: string | null | undefined): RarityTier {
  if (!rarity) return 'unknown';
  return RARITY_LOOKUP.get(rarity.trim().toLowerCase()) ?? 'unknown';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** True if the string contains Japanese script (used to add lang="ja"). */
export const hasJapanese = (s: string | null | undefined): boolean => !!s && /[\u3040-\u30ff\u3400-\u9fff]/.test(s);

/** Collection search: text that is only a collector number goes to localId (UX §4.1). */
export function parseCollectorQuery(raw: string): { q?: string; localId?: string; officialCount?: number } {
  const text = raw.trim();
  if (!text) return {};
  const m = /^([A-Za-z]{0,6}[- ]?\d+[A-Za-z]?)(?:\/(\d+))?$/.exec(text);
  if (m && !/\s/.test(m[1]!.replace(/^[A-Za-z]+ /, ''))) {
    return { localId: m[1]!, officialCount: m[2] ? Number(m[2]) : undefined };
  }
  return { q: text };
}

/** Completion percent for display: whole numbers, but "<1%" for anything above 0 that would floor to 0 (never a misleading "0%"). */
export function formatPercent(value: number | null | undefined): string {
  const v = value ?? 0;
  if (v > 0 && v < 1) return '<1%';
  return `${Math.floor(v)}%`;
}
