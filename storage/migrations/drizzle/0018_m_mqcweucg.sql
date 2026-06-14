CREATE TABLE `workflow_execution_state` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflow_execution_state_events` (
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`patch` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`execution_id`, `sequence`),
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
