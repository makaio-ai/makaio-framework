PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_step_spans` (
	`execution_id` text NOT NULL,
	`frame_id` text NOT NULL,
	`step_id` text NOT NULL,
	`step_type` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`duration_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`estimated_cost` real,
	`tool_call_count` integer,
	`input` text,
	`output` text,
	PRIMARY KEY(`execution_id`, `frame_id`),
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workflow_step_spans`("execution_id", "frame_id", "step_id", "step_type", "status", "started_at", "completed_at", "duration_ms", "input_tokens", "output_tokens", "estimated_cost", "tool_call_count", "input", "output") SELECT "execution_id", "step_id", "step_id", "step_type", "status", "started_at", "completed_at", "duration_ms", "input_tokens", "output_tokens", "estimated_cost", "tool_call_count", "input", "output" FROM `workflow_step_spans`;--> statement-breakpoint
DROP TABLE `workflow_step_spans`;--> statement-breakpoint
ALTER TABLE `__new_workflow_step_spans` RENAME TO `workflow_step_spans`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_workflow_step_spans_status` ON `workflow_step_spans` (`status`);
