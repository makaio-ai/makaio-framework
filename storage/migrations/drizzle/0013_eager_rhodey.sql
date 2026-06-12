DELETE FROM `workflow_run_contexts` WHERE `execution_id` NOT IN (SELECT `id` FROM `workflow_executions`);--> statement-breakpoint
DELETE FROM `worklog_summaries` WHERE `execution_id` NOT IN (SELECT `id` FROM `workflow_executions`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_run_contexts` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`coordinator_session_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_path` text,
	`source_filename` text,
	`source_code` text,
	`definition_snapshot` text,
	`worker_manifest` text NOT NULL,
	`inputs` text,
	`config` text DEFAULT '{}' NOT NULL,
	`trigger_payload` text NOT NULL,
	`artifact_ref` text,
	`execution_hints` text,
	`dispatch_metadata` text,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_kind` text DEFAULT '' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`cancel_subject` text NOT NULL,
	`context` text NOT NULL,
	`env` text NOT NULL,
	`created_at` integer NOT NULL,
	`suspension_strategy` text,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workflow_run_contexts`("execution_id", "workflow_id", "coordinator_session_id", "source_kind", "source_path", "source_filename", "source_code", "definition_snapshot", "worker_manifest", "inputs", "config", "trigger_payload", "artifact_ref", "execution_hints", "dispatch_metadata", "scope_type", "scope_kind", "scope_id", "cancel_subject", "context", "env", "created_at", "suspension_strategy") SELECT "execution_id", "workflow_id", "coordinator_session_id", "source_kind", "source_path", "source_filename", "source_code", "definition_snapshot", "worker_manifest", "inputs", "config", "trigger_payload", "artifact_ref", "execution_hints", "dispatch_metadata", "scope_type", "scope_kind", "scope_id", "cancel_subject", "context", "env", "created_at", "suspension_strategy" FROM `workflow_run_contexts`;--> statement-breakpoint
DROP TABLE `workflow_run_contexts`;--> statement-breakpoint
ALTER TABLE `__new_workflow_run_contexts` RENAME TO `workflow_run_contexts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_run_contexts_workflow` ON `workflow_run_contexts` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `__new_worklog_summaries` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_name` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`duration_ms` integer,
	`total_input_tokens` integer,
	`total_output_tokens` integer,
	`total_estimated_cost` real,
	`error` text,
	`failed_node_id` text,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_executions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_worklog_summaries`("execution_id", "workflow_id", "workflow_name", "status", "started_at", "completed_at", "duration_ms", "total_input_tokens", "total_output_tokens", "total_estimated_cost", "error", "failed_node_id") SELECT "execution_id", "workflow_id", "workflow_name", "status", "started_at", "completed_at", "duration_ms", "total_input_tokens", "total_output_tokens", "total_estimated_cost", "error", "failed_node_id" FROM `worklog_summaries`;--> statement-breakpoint
DROP TABLE `worklog_summaries`;--> statement-breakpoint
ALTER TABLE `__new_worklog_summaries` RENAME TO `worklog_summaries`;--> statement-breakpoint
CREATE INDEX `idx_worklog_summaries_workflow_started` ON `worklog_summaries` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_worklog_summaries_status` ON `worklog_summaries` (`status`);