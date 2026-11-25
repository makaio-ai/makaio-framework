CREATE TABLE `journal_writes` (
	`write_record_id` text PRIMARY KEY NOT NULL,
	`writer` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`state` text NOT NULL,
	`version` text NOT NULL,
	`lease_until` integer NOT NULL,
	`intent_id` text NOT NULL,
	`intent` text NOT NULL,
	`ctx` text NOT NULL,
	`object` text,
	`applied_object` text,
	`object_key` text,
	`parent` text,
	`parent_key` text,
	`checksum` text,
	`applied_order` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_writes_writer_key_uq` ON `journal_writes` (`writer`,`key`);--> statement-breakpoint
CREATE INDEX `journal_writes_object_page_idx` ON `journal_writes` (`object_key`,`created_at`,`write_record_id`);--> statement-breakpoint
CREATE INDEX `journal_writes_parent_page_idx` ON `journal_writes` (`parent_key`,`created_at`,`write_record_id`);