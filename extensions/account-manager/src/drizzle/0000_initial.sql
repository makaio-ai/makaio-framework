CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`label` text,
	`metadata` text NOT NULL,
	`metadata_generation` integer DEFAULT 0 NOT NULL,
	`active` integer NOT NULL,
	`detected_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_accounts_client_active` ON `accounts` (`client_id`,`active`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_accounts_active_client` ON `accounts` (`client_id`) WHERE `active` = 1;
--> statement-breakpoint
CREATE TABLE `account_timeline` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`from_account_id` text,
	`to_account_id` text NOT NULL,
	`effective_at` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_account_timeline_client_effective` ON `account_timeline` (`client_id`,`effective_at`);
--> statement-breakpoint
CREATE TABLE `usage_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`account_id` text NOT NULL,
	`window_id` text NOT NULL,
	`utilization` real NOT NULL,
	`resets_at` integer NOT NULL,
	`blocked` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_snapshots_client_account_fetched` ON `usage_snapshots` (`client_id`,`account_id`,`fetched_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_usage_snapshots_identity` ON `usage_snapshots` (`client_id`,`account_id`,`window_id`,`fetched_at`);
