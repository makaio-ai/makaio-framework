DROP INDEX `uniq_accounts_active_client`;--> statement-breakpoint
ALTER TABLE `accounts` ADD `linked_client_account_id` text;--> statement-breakpoint
CREATE INDEX `idx_accounts_client_linked_client_account` ON `accounts` (`client_id`,`linked_client_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_accounts_active_client` ON `accounts` (`client_id`) WHERE "accounts"."active" = 1;