CREATE TABLE `acquisitions` (
	`id` text PRIMARY KEY NOT NULL,
	`purchased_on` text,
	`source` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `acq_date` ON `acquisitions` (`purchased_on`,`id`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`languages_json` text DEFAULT '["en","ja"]' NOT NULL,
	`sets_followed_json` text DEFAULT '[]' NOT NULL,
	`sync_all_sets` integer DEFAULT false NOT NULL,
	`hide_tcg_pocket` integer DEFAULT true NOT NULL,
	`default_currency` text DEFAULT 'USD' NOT NULL,
	`disclaimer_acknowledged` integer DEFAULT false NOT NULL,
	`disclaimer_acknowledged_at` text,
	`onboarding_completed_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("app_settings"."id" = 'app'),
	CONSTRAINT "settings_currency" CHECK("app_settings"."default_currency" IN ('USD','EUR')),
	CONSTRAINT "settings_booleans" CHECK("app_settings"."sync_all_sets" IN (0,1) AND "app_settings"."hide_tcg_pocket" IN (0,1)
    AND "app_settings"."disclaimer_acknowledged" IN (0,1)),
	CONSTRAINT "settings_disclaimer" CHECK(("app_settings"."disclaimer_acknowledged" = 0 AND "app_settings"."disclaimer_acknowledged_at" IS NULL)
    OR ("app_settings"."disclaimer_acknowledged" = 1 AND "app_settings"."disclaimer_acknowledged_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `app_state` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "app_singleton" CHECK("app_state"."id" = 'collection'),
	CONSTRAINT "app_revision" CHECK("app_state"."collection_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `catalog_annotations` (
	`language` text NOT NULL,
	`catalog_card_id` text NOT NULL,
	`display_overrides_json` text NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`language`, `catalog_card_id`),
	FOREIGN KEY (`language`,`catalog_card_id`) REFERENCES `catalog_identities`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "ca_language" CHECK("catalog_annotations"."language" IN ('en','ja'))
);
--> statement-breakpoint
CREATE TABLE `catalog_identities` (
	`language` text NOT NULL,
	`id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`language`, `id`),
	CONSTRAINT "ci_language" CHECK("catalog_identities"."language" IN ('en','ja'))
);
--> statement-breakpoint
CREATE TABLE `catalog_install_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`state` text NOT NULL,
	`lock_key` text,
	`token` text NOT NULL,
	`manifest_entry_json` text NOT NULL,
	`compressed_bytes_done` integer DEFAULT 0 NOT NULL,
	`decompressed_bytes_done` integer DEFAULT 0 NOT NULL,
	`etag` text,
	`progress_json` text NOT NULL,
	`journal_json` text NOT NULL,
	`last_error_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "cij_language" CHECK("catalog_install_jobs"."language" IN ('en','ja')),
	CONSTRAINT "cij_state" CHECK("catalog_install_jobs"."state" IN ('checking','downloading','downloaded','size_checked','decompressing','verifying','validating','prepared','activating','validating_active','committed','installed','cancelled','failed','interrupted','rolling_back')),
	CONSTRAINT "cij_lock" CHECK("catalog_install_jobs"."lock_key" IS NULL OR "catalog_install_jobs"."lock_key" = 'catalog-install'),
	CONSTRAINT "cij_bytes" CHECK("catalog_install_jobs"."compressed_bytes_done" >= 0 AND "catalog_install_jobs"."decompressed_bytes_done" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_install_jobs_lock_key_unique` ON `catalog_install_jobs` (`lock_key`);--> statement-breakpoint
CREATE INDEX `install_language_created` ON `catalog_install_jobs` (`language`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `collection_group_members` (
	`collection_group_id` text NOT NULL,
	`owned_card_id` text NOT NULL,
	PRIMARY KEY(`collection_group_id`, `owned_card_id`),
	FOREIGN KEY (`collection_group_id`) REFERENCES `collection_groups`(`id`) ON UPDATE restrict ON DELETE cascade,
	FOREIGN KEY (`owned_card_id`) REFERENCES `owned_cards`(`id`) ON UPDATE restrict ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_copy` ON `collection_group_members` (`owned_card_id`);--> statement-breakpoint
CREATE TABLE `collection_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `group_name_key` ON `collection_groups` (`name_key`);--> statement-breakpoint
CREATE TABLE `custom_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`set_id` text,
	`set_name` text,
	`local_id` text,
	`language` text NOT NULL,
	`rarity` text,
	`image_url` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "custom_language" CHECK("custom_cards"."language" IN ('en','ja'))
);
--> statement-breakpoint
CREATE INDEX `custom_name` ON `custom_cards` (`name_search`,`id`);--> statement-breakpoint
CREATE TABLE `data_operation_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`plan_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`committed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT "receipt_operation" CHECK("data_operation_receipts"."operation" = 'import')
);
--> statement-breakpoint
CREATE INDEX `receipt_expiry` ON `data_operation_receipts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `grades` (
	`id` text PRIMARY KEY NOT NULL,
	`owned_card_id` text NOT NULL,
	`company` text NOT NULL,
	`company_label` text,
	`grade` text NOT NULL,
	`cert_number` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owned_card_id`) REFERENCES `owned_cards`(`id`) ON UPDATE restrict ON DELETE cascade,
	CONSTRAINT "grade_company_valid" CHECK("grades"."company" IN ('PSA','BGS','CGC','SGC','ACE','TAG','other')),
	CONSTRAINT "grade_other_label" CHECK("grades"."company" <> 'other' OR ("grades"."company_label" IS NOT NULL AND length(trim("grades"."company_label")) > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grade_copy` ON `grades` (`owned_card_id`);--> statement-breakpoint
CREATE INDEX `grade_company` ON `grades` (`company`);--> statement-breakpoint
CREATE INDEX `grade_cert` ON `grades` (`company`,`cert_number`);--> statement-breakpoint
CREATE TABLE `installed_catalogs` (
	`language` text PRIMARY KEY NOT NULL,
	`version` text,
	`sha256` text,
	`installed_at` text,
	`status` text NOT NULL,
	`schema_version` integer,
	`generation` integer DEFAULT 0 NOT NULL,
	`active_ref` text,
	CONSTRAINT "ic_language" CHECK("installed_catalogs"."language" IN ('en','ja')),
	CONSTRAINT "ic_generation" CHECK("installed_catalogs"."generation" >= 0),
	CONSTRAINT "ic_status_shape" CHECK(("installed_catalogs"."status" = 'absent' AND "installed_catalogs"."version" IS NULL AND "installed_catalogs"."sha256" IS NULL AND "installed_catalogs"."installed_at" IS NULL AND "installed_catalogs"."active_ref" IS NULL AND "installed_catalogs"."schema_version" IS NULL)
    OR ("installed_catalogs"."status" IN ('installed','failed') AND "installed_catalogs"."version" IS NOT NULL AND "installed_catalogs"."sha256" IS NOT NULL AND "installed_catalogs"."installed_at" IS NOT NULL AND "installed_catalogs"."active_ref" IS NOT NULL AND "installed_catalogs"."schema_version" >= 1))
);
--> statement-breakpoint
CREATE TABLE `owned_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_card_id` text,
	`custom_card_id` text,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`set_id` text,
	`set_name` text,
	`local_id` text,
	`language` text NOT NULL,
	`rarity` text,
	`image_url` text,
	`variant` text DEFAULT 'normal' NOT NULL,
	`variant_detail` text DEFAULT '' NOT NULL,
	`condition` text,
	`acquisition_id` text,
	`purchase_price_cents` integer,
	`purchase_currency` text,
	`storage_location_id` text,
	`scan_session_id` text,
	`notes` text,
	`manual_price_cents` integer,
	`manual_price_currency` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`custom_card_id`) REFERENCES `custom_cards`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`acquisition_id`) REFERENCES `acquisitions`(`id`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`storage_location_id`) REFERENCES `storage_locations`(`id`) ON UPDATE restrict ON DELETE set null,
	FOREIGN KEY (`scan_session_id`) REFERENCES `scan_sessions`(`id`) ON UPDATE restrict ON DELETE set null,
	FOREIGN KEY (`language`,`catalog_card_id`) REFERENCES `catalog_identities`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "owned_one_reference" CHECK(("owned_cards"."catalog_card_id" IS NOT NULL AND "owned_cards"."custom_card_id" IS NULL)
    OR ("owned_cards"."catalog_card_id" IS NULL AND "owned_cards"."custom_card_id" IS NOT NULL)),
	CONSTRAINT "owned_language" CHECK("owned_cards"."language" IN ('en','ja')),
	CONSTRAINT "owned_catalog_snapshot" CHECK("owned_cards"."catalog_card_id" IS NULL OR ("owned_cards"."set_id" IS NOT NULL AND "owned_cards"."local_id" IS NOT NULL)),
	CONSTRAINT "owned_variant" CHECK("owned_cards"."variant" IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')),
	CONSTRAINT "owned_variant_detail" CHECK("owned_cards"."variant" <> 'other' OR length(trim("owned_cards"."variant_detail")) > 0),
	CONSTRAINT "owned_condition" CHECK("owned_cards"."condition" IS NULL OR "owned_cards"."condition" IN ('NM','LP','MP','HP','DMG')),
	CONSTRAINT "owned_purchase" CHECK(("owned_cards"."purchase_price_cents" IS NULL AND "owned_cards"."purchase_currency" IS NULL)
    OR ("owned_cards"."purchase_price_cents" IS NOT NULL AND "owned_cards"."purchase_currency" IS NOT NULL
      AND "owned_cards"."purchase_price_cents" BETWEEN 0 AND 2147483647 AND "owned_cards"."purchase_currency" IN ('USD','EUR'))),
	CONSTRAINT "owned_manual" CHECK(("owned_cards"."manual_price_cents" IS NULL AND "owned_cards"."manual_price_currency" IS NULL)
    OR ("owned_cards"."manual_price_cents" IS NOT NULL AND "owned_cards"."manual_price_currency" IS NOT NULL
      AND "owned_cards"."manual_price_cents" BETWEEN 0 AND 2147483647 AND "owned_cards"."manual_price_currency" IN ('USD','EUR')))
);
--> statement-breakpoint
CREATE INDEX `owned_catalog_variant` ON `owned_cards` (`language`,`catalog_card_id`,`variant`,`variant_detail`);--> statement-breakpoint
CREATE INDEX `owned_custom_variant` ON `owned_cards` (`custom_card_id`,`variant`,`variant_detail`);--> statement-breakpoint
CREATE INDEX `owned_name` ON `owned_cards` (`name_search`,`id`);--> statement-breakpoint
CREATE INDEX `owned_set` ON `owned_cards` (`language`,`set_id`,`local_id`);--> statement-breakpoint
CREATE INDEX `owned_filters` ON `owned_cards` (`language`,`condition`,`rarity`);--> statement-breakpoint
CREATE INDEX `owned_storage` ON `owned_cards` (`storage_location_id`);--> statement-breakpoint
CREATE INDEX `owned_acquisition` ON `owned_cards` (`acquisition_id`);--> statement-breakpoint
CREATE INDEX `owned_scan` ON `owned_cards` (`scan_session_id`);--> statement-breakpoint
CREATE INDEX `owned_created` ON `owned_cards` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `pack_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`version` text NOT NULL,
	`operation_id` text NOT NULL,
	`metrics_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "pm_language" CHECK("pack_metrics"."language" IN ('en','ja'))
);
--> statement-breakpoint
CREATE INDEX `metrics_operation` ON `pack_metrics` (`operation_id`,`id`);--> statement-breakpoint
CREATE TABLE `price_snapshots` (
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
	FOREIGN KEY (`language`,`catalog_card_id`) REFERENCES `catalog_identities`(`language`,`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "price_language" CHECK("price_snapshots"."language" IN ('en','ja')),
	CONSTRAINT "price_source_currency" CHECK(("price_snapshots"."source" = 'tcgplayer' AND "price_snapshots"."currency" = 'USD')
    OR ("price_snapshots"."source" = 'cardmarket' AND "price_snapshots"."currency" = 'EUR')),
	CONSTRAINT "price_variant" CHECK("price_snapshots"."variant" IN ('normal','holo','reverse_holo','first_edition','promo_stamped','shadowless','other')),
	CONSTRAINT "price_low" CHECK("price_snapshots"."low_cents" IS NULL OR "price_snapshots"."low_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "price_mid" CHECK("price_snapshots"."mid_cents" IS NULL OR "price_snapshots"."mid_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "price_high" CHECK("price_snapshots"."high_cents" IS NULL OR "price_snapshots"."high_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "price_market" CHECK("price_snapshots"."market_cents" IS NULL OR "price_snapshots"."market_cents" BETWEEN 0 AND 2147483647),
	CONSTRAINT "price_trend" CHECK("price_snapshots"."trend_cents" IS NULL OR "price_snapshots"."trend_cents" BETWEEN 0 AND 2147483647)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_observation` ON `price_snapshots` (`observation_key`);--> statement-breakpoint
CREATE INDEX `price_latest` ON `price_snapshots` (`language`,`catalog_card_id`,`variant`,`variant_detail`,`currency`,`source`,`captured_at`,`id`);--> statement-breakpoint
CREATE TABLE `scan_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`notes` text,
	CONSTRAINT "scan_status" CHECK("scan_sessions"."status" IN ('open','closed','abandoned')),
	CONSTRAINT "scan_closed_at" CHECK(("scan_sessions"."status" = 'open' AND "scan_sessions"."ended_at" IS NULL)
    OR ("scan_sessions"."status" <> 'open' AND "scan_sessions"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `scan_started` ON `scan_sessions` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`version` text PRIMARY KEY NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_name_key` ON `storage_locations` (`name_key`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`mode` text DEFAULT 'incremental' NOT NULL,
	`languages_json` text NOT NULL,
	`selection_json` text NOT NULL,
	`lock_key` text,
	`worker_token` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`sets_total` integer,
	`sets_done` integer DEFAULT 0 NOT NULL,
	`cards_total` integer,
	`cards_done` integer DEFAULT 0 NOT NULL,
	`cards_failed` integer DEFAULT 0 NOT NULL,
	`checkpoint_json` text DEFAULT '{}' NOT NULL,
	`last_error_json` text,
	`heartbeat_at` text,
	`lease_expires_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "sync_status" CHECK("sync_state"."status" IN ('queued','running','cancel_requested','completed','failed','cancelled','interrupted')),
	CONSTRAINT "sync_mode" CHECK("sync_state"."mode" IN ('incremental','refresh','prices_only')),
	CONSTRAINT "sync_lock_value" CHECK("sync_state"."lock_key" IS NULL OR "sync_state"."lock_key" = 'catalog'),
	CONSTRAINT "sync_counts" CHECK("sync_state"."attempt" >= 1 AND "sync_state"."sets_done" >= 0 AND "sync_state"."cards_done" >= 0 AND "sync_state"."cards_failed" >= 0
    AND ("sync_state"."sets_total" IS NULL OR "sync_state"."sets_total" >= "sync_state"."sets_done")
    AND ("sync_state"."cards_total" IS NULL OR "sync_state"."cards_total" >= "sync_state"."cards_done" + "sync_state"."cards_failed"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_lock` ON `sync_state` (`lock_key`);--> statement-breakpoint
CREATE INDEX `sync_created` ON `sync_state` (`created_at`,`id`);