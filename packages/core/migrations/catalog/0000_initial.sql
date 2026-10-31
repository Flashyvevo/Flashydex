CREATE TABLE `catalog_cards` (
	`language` text NOT NULL,
	`id` text NOT NULL,
	`set_id` text NOT NULL,
	`local_id` text NOT NULL,
	`local_id_sort` text NOT NULL,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`rarity` text,
	`category` text,
	`illustrator` text,
	`image_url` text,
	`has_normal` integer DEFAULT false NOT NULL,
	`has_holo` integer DEFAULT false NOT NULL,
	`has_reverse` integer DEFAULT false NOT NULL,
	`has_first_edition` integer DEFAULT false NOT NULL,
	`w_promo` integer DEFAULT false NOT NULL,
	`available_variants_json` text DEFAULT '[]' NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text NOT NULL,
	`detail_synced_at` text,
	PRIMARY KEY(`language`, `id`),
	FOREIGN KEY (`language`,`set_id`) REFERENCES `catalog_sets`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "cc_language" CHECK("catalog_cards"."language" IN ('en','ja')),
	CONSTRAINT "cc_flags" CHECK("catalog_cards"."has_normal" IN (0,1) AND "catalog_cards"."has_holo" IN (0,1)
    AND "catalog_cards"."has_reverse" IN (0,1) AND "catalog_cards"."has_first_edition" IN (0,1) AND "catalog_cards"."w_promo" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cc_set_local` ON `catalog_cards` (`language`,`set_id`,`local_id`);--> statement-breakpoint
CREATE INDEX `cc_name` ON `catalog_cards` (`name_search`,`language`,`id`);--> statement-breakpoint
CREATE INDEX `cc_language_name` ON `catalog_cards` (`language`,`name_search`,`id`);--> statement-breakpoint
CREATE INDEX `cc_set_sort` ON `catalog_cards` (`language`,`set_id`,`local_id_sort`,`id`);--> statement-breakpoint
CREATE INDEX `cc_rarity` ON `catalog_cards` (`language`,`rarity`);--> statement-breakpoint
CREATE TABLE `catalog_latest_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_card_id` text NOT NULL,
	`language` text NOT NULL,
	`source` text NOT NULL,
	`variant` text NOT NULL,
	`variant_detail` text DEFAULT '' NOT NULL,
	`provider_variant_key` text NOT NULL,
	`currency` text NOT NULL,
	`low_cents` integer,
	`mid_cents` integer,
	`high_cents` integer,
	`market_cents` integer,
	`trend_cents` integer,
	`source_updated_at` text,
	`captured_at` text NOT NULL,
	`observation_key` text NOT NULL,
	FOREIGN KEY (`language`,`catalog_card_id`) REFERENCES `catalog_cards`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "clp_language" CHECK("catalog_latest_prices"."language" IN ('en','ja')),
	CONSTRAINT "clp_source_currency" CHECK(("catalog_latest_prices"."source" = 'tcgplayer' AND "catalog_latest_prices"."currency" = 'USD')
    OR ("catalog_latest_prices"."source" = 'cardmarket' AND "catalog_latest_prices"."currency" = 'EUR')),
	CONSTRAINT "clp_variant" CHECK("catalog_latest_prices"."variant" IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')),
	CONSTRAINT "clp_low" CHECK("catalog_latest_prices"."low_cents" IS NULL OR "catalog_latest_prices"."low_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "clp_mid" CHECK("catalog_latest_prices"."mid_cents" IS NULL OR "catalog_latest_prices"."mid_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "clp_high" CHECK("catalog_latest_prices"."high_cents" IS NULL OR "catalog_latest_prices"."high_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "clp_market" CHECK("catalog_latest_prices"."market_cents" IS NULL OR "catalog_latest_prices"."market_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "clp_trend" CHECK("catalog_latest_prices"."trend_cents" IS NULL OR "catalog_latest_prices"."trend_cents" BETWEEN 0 AND 2147483647)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clp_observation` ON `catalog_latest_prices` (`observation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `clp_tuple` ON `catalog_latest_prices` (`language`,`catalog_card_id`,`source`,`variant`,`variant_detail`,`provider_variant_key`,`currency`);--> statement-breakpoint
CREATE INDEX `clp_latest` ON `catalog_latest_prices` (`language`,`catalog_card_id`,`source`,`variant`,`variant_detail`,`provider_variant_key`,`currency`,`source_updated_at`,`captured_at`,`id`);--> statement-breakpoint
CREATE TABLE `catalog_meta` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`version` text NOT NULL,
	`schema_version` integer NOT NULL,
	`built_at` text NOT NULL,
	`builder_version` text NOT NULL,
	`source_cutoff_at` text NOT NULL,
	`source_set_count` integer NOT NULL,
	`source_card_count` integer NOT NULL,
	`source_variant_count` integer NOT NULL,
	`source_price_count` integer NOT NULL,
	`unpublished_set_count` integer NOT NULL,
	`schema_fingerprint` text NOT NULL,
	CONSTRAINT "catalog_singleton" CHECK("catalog_meta"."id" = 'catalog'),
	CONSTRAINT "meta_language" CHECK("catalog_meta"."language" IN ('en','ja')),
	CONSTRAINT "meta_schema_version" CHECK("catalog_meta"."schema_version" >= 1),
	CONSTRAINT "meta_counts" CHECK("catalog_meta"."source_set_count" >= 0 AND "catalog_meta"."source_card_count" >= 0 AND "catalog_meta"."source_variant_count" >= 0
    AND "catalog_meta"."source_price_count" >= 0 AND "catalog_meta"."unpublished_set_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE `catalog_sets` (
	`language` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`series` text,
	`status` text DEFAULT 'unpublished' NOT NULL,
	`release_date` text,
	`official_count` integer,
	`total_count` integer,
	`logo_url` text,
	`symbol_url` text,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`synced_at` text NOT NULL,
	PRIMARY KEY(`language`, `id`),
	CONSTRAINT "cs_status" CHECK("catalog_sets"."status" IN ('published','unpublished')),
	CONSTRAINT "cs_language" CHECK("catalog_sets"."language" IN ('en','ja')),
	CONSTRAINT "cs_counts" CHECK(("catalog_sets"."official_count" IS NULL OR "catalog_sets"."official_count" >= 0)
    AND ("catalog_sets"."total_count" IS NULL OR "catalog_sets"."total_count" >= 0))
);
--> statement-breakpoint
CREATE INDEX `cs_language_name` ON `catalog_sets` (`language`,`name_search`,`id`);--> statement-breakpoint
CREATE INDEX `cs_visibility` ON `catalog_sets` (`status`,`series`,`language`,`id`);--> statement-breakpoint
CREATE TABLE `catalog_variants` (
	`language` text NOT NULL,
	`card_id` text NOT NULL,
	`variant_key` text NOT NULL,
	`variant` text NOT NULL,
	`variant_detail` text DEFAULT '' NOT NULL,
	`provider_variant_id` text,
	`type` text NOT NULL,
	`subtype` text,
	`foil` text,
	`size` text NOT NULL,
	`stamps_json` text NOT NULL,
	`attributes_json` text NOT NULL,
	PRIMARY KEY(`language`, `card_id`, `variant_key`),
	FOREIGN KEY (`language`,`card_id`) REFERENCES `catalog_cards`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "cv_language" CHECK("catalog_variants"."language" IN ('en','ja')),
	CONSTRAINT "cv_variant" CHECK("catalog_variants"."variant" IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other'))
);
--> statement-breakpoint
CREATE INDEX `cv_lookup` ON `catalog_variants` (`language`,`card_id`,`variant`,`variant_detail`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` text PRIMARY KEY NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` text NOT NULL
);
