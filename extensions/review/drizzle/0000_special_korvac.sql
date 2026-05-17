CREATE TABLE `extension_review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`pr_number` integer,
	`branch` text,
	`head_sha` text,
	`source_id` text NOT NULL,
	`reviewer` text NOT NULL,
	`origin` text NOT NULL,
	`thread_id` text,
	`severity` text NOT NULL,
	`file` text,
	`start_line` integer,
	`end_line` integer,
	`message` text NOT NULL,
	`agent_prompt` text,
	`suggested_changes` text NOT NULL,
	`status` text NOT NULL,
	`addressed_by` text,
	`addressed_at` integer,
	`verified_at` integer,
	`dismissed_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`raw_comment_id` integer
);
--> statement-breakpoint
CREATE INDEX `idx_review_findings_repo_pr` ON `extension_review_findings` (`repository`,`pr_number`);--> statement-breakpoint
CREATE INDEX `idx_review_findings_status` ON `extension_review_findings` (`status`);--> statement-breakpoint
CREATE INDEX `idx_review_findings_reviewer` ON `extension_review_findings` (`reviewer`);--> statement-breakpoint
CREATE INDEX `idx_review_findings_source` ON `extension_review_findings` (`source_id`);