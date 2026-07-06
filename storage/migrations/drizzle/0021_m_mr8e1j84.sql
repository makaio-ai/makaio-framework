ALTER TABLE `sessions` ADD `is_sidechain` integer;--> statement-breakpoint
ALTER TABLE `turns` ADD `turn_anchor_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_turns_session_anchor` ON `turns` (`session_id`,`turn_anchor_id`);