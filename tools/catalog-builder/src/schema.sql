PRAGMA page_size = 4096;
PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;

CREATE TABLE catalog_sets (
  language TEXT NOT NULL CHECK(language IN ('en', 'ja')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_search TEXT NOT NULL,
  series TEXT,
  status TEXT NOT NULL CHECK(status IN ('published', 'unpublished')),
  release_date TEXT,
  official_count INTEGER,
  total_count INTEGER,
  logo_url TEXT,
  symbol_url TEXT,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY(language, id)
);
CREATE INDEX cs_language_name ON catalog_sets(language, name_search, id);
CREATE INDEX cs_visibility ON catalog_sets(status, series, language, id);

CREATE TABLE catalog_cards (
  language TEXT NOT NULL CHECK(language IN ('en', 'ja')),
  id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  local_id_sort TEXT NOT NULL,
  name TEXT NOT NULL,
  name_search TEXT NOT NULL,
  rarity TEXT,
  category TEXT,
  illustrator TEXT,
  image_url TEXT,
  has_normal INTEGER NOT NULL CHECK(has_normal IN (0, 1)),
  has_holo INTEGER NOT NULL CHECK(has_holo IN (0, 1)),
  has_reverse INTEGER NOT NULL CHECK(has_reverse IN (0, 1)),
  has_first_edition INTEGER NOT NULL CHECK(has_first_edition IN (0, 1)),
  w_promo INTEGER NOT NULL CHECK(w_promo IN (0, 1)),
  available_variants_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  detail_synced_at TEXT,
  PRIMARY KEY(language, id),
  FOREIGN KEY(language, set_id) REFERENCES catalog_sets(language, id) ON DELETE RESTRICT,
  UNIQUE(language, set_id, local_id)
);
CREATE INDEX cc_name ON catalog_cards(name_search, language, id);
CREATE INDEX cc_language_name ON catalog_cards(language, name_search, id);
CREATE INDEX cc_set_sort ON catalog_cards(language, set_id, local_id_sort, id);

CREATE TABLE catalog_variants (
  language TEXT NOT NULL CHECK(language IN ('en', 'ja')),
  catalog_card_id TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  variant TEXT NOT NULL,
  variant_detail TEXT NOT NULL DEFAULT '',
  raw_type TEXT,
  raw_subtype TEXT,
  raw_foil TEXT,
  raw_size TEXT,
  raw_stamps_json TEXT NOT NULL DEFAULT '[]',
  provider_variant_id TEXT,
  attributes_json TEXT NOT NULL,
  PRIMARY KEY(language, catalog_card_id, variant_key),
  FOREIGN KEY(language, catalog_card_id) REFERENCES catalog_cards(language, id) ON DELETE RESTRICT
);

CREATE TABLE catalog_latest_prices (
  language TEXT NOT NULL CHECK(language IN ('en', 'ja')),
  catalog_card_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('tcgplayer', 'cardmarket')),
  variant TEXT NOT NULL,
  variant_detail TEXT NOT NULL DEFAULT '',
  provider_variant_key TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('USD', 'EUR')),
  low_cents INTEGER,
  mid_cents INTEGER,
  high_cents INTEGER,
  market_cents INTEGER,
  trend_cents INTEGER,
  source_updated_at TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(language, catalog_card_id, source, variant, variant_detail, provider_variant_key, currency),
  FOREIGN KEY(language, catalog_card_id) REFERENCES catalog_cards(language, id) ON DELETE RESTRICT
);

CREATE TABLE catalog_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  language TEXT NOT NULL CHECK(language IN ('en', 'ja')),
  version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  built_at TEXT NOT NULL,
  builder_version TEXT NOT NULL,
  source_set_count INTEGER NOT NULL,
  source_card_count INTEGER NOT NULL,
  source_cutoff TEXT NOT NULL,
  schema_fingerprint TEXT NOT NULL
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
