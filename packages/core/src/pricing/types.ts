/**
 * Provider-neutral pricing vocabulary (pricing-v2). Pure types; nothing here is wired into services.
 *
 * The central rule: a LISTING estimate, a provider's own SALE AVERAGE and a VERIFIED SALE are three different
 * things and are never interchangeable. `MarketQuote.kind` says which one a number is; `SoldRecord` can only be a
 * verified sale (its `kind` is the literal 'verified-sale'), so listings cannot be passed where sales are required.
 */

export type PricingLanguage = 'en' | 'ja';
export type PricingCurrency = 'USD' | 'EUR' | 'JPY' | 'GBP';

/** Which card/print a quote or sale is about. `variant`/`variantDetail` are provider-neutral strings. */
export interface CardIdentity {
  language: PricingLanguage;
  /** Catalog card id, e.g. `swsh3-136`. */
  cardId: string;
  variant: string;
  variantDetail: string;
}

export type QuoteType = 'market' | 'mid' | 'low' | 'high' | 'trend' | 'avg' | 'avg1' | 'avg7' | 'avg30' | 'directLow';

/**
 * - listing-estimate:        derived from what is currently for sale / the provider's own blend (not a sale record)
 * - provider-sale-average:   the provider says it averages completed sales (window per quoteType); we cannot audit it
 * - verified-sale:           an individual completed sale we hold a record for (only `SoldRecord` produces these)
 */
export type QuoteKind = 'listing-estimate' | 'provider-sale-average' | 'verified-sale';

export interface MarketQuote {
  provider: string;
  cardIdentity: CardIdentity;
  quoteType: QuoteType;
  kind: QuoteKind;
  currency: PricingCurrency;
  cents: number;
  /** When WE observed/fetched the value (ISO-8601 UTC). */
  observedAt: string;
  /** The provider's own timestamp for the value (ISO-8601 UTC), when it supplies one. */
  providerUpdatedAt: string | null;
  /**
   * Set when the provider says how a figure is derived but not the window/method we could audit (e.g. TCGplayer `market`:
   * "average across multiple recent transactions", window unspecified). Absent = no such caveat. Never implies a verified sale.
   */
  methodology?: 'provider-unspecified';
}

export interface GradedInfo {
  company: string;
  grade: string;
}

export interface SoldRecord {
  /** Literal brand: only completed sales may be a SoldRecord. A listing is a type error here. */
  kind: 'verified-sale';
  provider: string;
  cardIdentity: CardIdentity;
  /** Raw card condition (e.g. 'NM', 'LP') or 'unknown'. Graded cards carry `graded` instead. */
  condition: string;
  graded: GradedInfo | null;
  priceCents: number;
  currency: PricingCurrency;
  shippingIncluded: boolean | 'unknown';
  /** ISO-8601 UTC. */
  soldAt: string;
  /** True when the sale was a lot/bundle of several cards; such records are excluded from summaries. */
  bundle?: boolean;
  url?: string;
}

export type OutlierRule = 'iqr' | 'mad';

export interface SoldSummaryBucket {
  /** null = raw (ungraded). */
  graded: GradedInfo | null;
  currency: PricingCurrency;
}

export interface SoldSummary {
  bucket: SoldSummaryBucket;
  windowDays: number;
  /** Records that contributed to mean/median. */
  n: number;
  meanCents: number | null;
  medianCents: number | null;
  outlierRule: OutlierRule;
  excluded: { outOfWindow: number; bundle: number; outlier: number };
  /** Sum of `excluded` for convenience. */
  excludedTotal: number;
}

export interface SoldWindow {
  days: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface ProviderCapabilities {
  provider: string;
  languages: readonly PricingLanguage[];
  currencies: readonly PricingCurrency[];
  quoteTypes: readonly QuoteType[];
  /** Does the provider return individual completed sales (`sold`)? */
  sales: boolean;
  /** Does the provider return listing-derived estimates? */
  listings: boolean;
  graded: boolean;
}

export interface PriceProvider {
  capabilities(): ProviderCapabilities;
  quotes(ids: readonly CardIdentity[]): Promise<MarketQuote[]>;
  /** Only providers with `capabilities().sales === true` implement this. */
  sold?(id: CardIdentity, window: SoldWindow): Promise<SoldRecord[]>;
}
