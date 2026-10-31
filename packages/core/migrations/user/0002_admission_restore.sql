CREATE TABLE `work_admission` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token` text NOT NULL,
	`languages_json` text NOT NULL,
	`acquired_at` text NOT NULL,
	CONSTRAINT `wa_single` CHECK(`id` = 'lock'),
	CONSTRAINT `wa_kind` CHECK(`kind` IN ('install','uninstall','rollback','sync','restore'))
);
--> statement-breakpoint
CREATE TABLE `restore_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`restored_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `restore_receipt_expiry` ON `restore_receipts` (`expires_at`);
