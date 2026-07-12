CREATE TABLE `workflow_finalizations` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`finalizer_id` text NOT NULL,
	`transition_key` text NOT NULL,
	`claim_token` text NOT NULL,
	`intent` text NOT NULL,
	`state` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`settled_at` integer,
	`failure` text,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_workflow_finalizations_transition` ON `workflow_finalizations` (`transition_key`);--> statement-breakpoint
CREATE INDEX `idx_workflow_finalizations_recovery` ON `workflow_finalizations` (`finalizer_id`,`state`);