INSERT INTO `app_state` (`id`, `collection_revision`, `updated_at`) VALUES ('collection', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
INSERT INTO `app_settings` (`id`, `languages_json`, `sets_followed_json`, `sync_all_sets`, `hide_tcg_pocket`, `default_currency`, `disclaimer_acknowledged`, `disclaimer_acknowledged_at`, `onboarding_completed_at`, `updated_at`) VALUES ('app', '["en","ja"]', '[]', 0, 1, 'USD', 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
INSERT INTO `installed_catalogs` (`language`, `version`, `sha256`, `installed_at`, `status`, `schema_version`, `generation`, `active_ref`) VALUES ('en', NULL, NULL, NULL, 'absent', NULL, 0, NULL);
--> statement-breakpoint
INSERT INTO `installed_catalogs` (`language`, `version`, `sha256`, `installed_at`, `status`, `schema_version`, `generation`, `active_ref`) VALUES ('ja', NULL, NULL, NULL, 'absent', NULL, 0, NULL);
