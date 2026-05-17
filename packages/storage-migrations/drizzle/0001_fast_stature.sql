CREATE TABLE `client_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`config_dir` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_client_profiles_client_name` ON `client_profiles` (`client_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_client_profiles_client_id` ON `client_profiles` (`client_id`);