CREATE TABLE `workflow_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`description` text,
	`inputs` text,
	`steps` text NOT NULL,
	`default_execution_target_id` text,
	`triggers` text,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`canvas_layout` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_workflow_definitions_name_scope` ON `workflow_definitions` (`name`,`scope`);--> statement-breakpoint
CREATE INDEX `idx_workflow_definitions_project_id` ON `workflow_definitions` (`project_id`);--> statement-breakpoint
CREATE TABLE `workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`coordinator_session_id` text,
	`status` text NOT NULL,
	`inputs` text NOT NULL,
	`steps` text NOT NULL,
	`current_step_id` text,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`trigger_payload` text,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_workflow_id` ON `workflow_executions` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_status` ON `workflow_executions` (`status`);
