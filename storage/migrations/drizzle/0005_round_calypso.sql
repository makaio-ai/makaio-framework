PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`coordinator_session_id` text,
	`status` text NOT NULL,
	`inputs` text,
	`error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`trigger_payload` text,
	`scope_type` text NOT NULL,
	`scope_kind` text DEFAULT '' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workflow_executions`("id", "workflow_id", "coordinator_session_id", "status", "inputs", "error", "started_at", "completed_at", "trigger_payload", "scope_type", "scope_kind", "scope_id") SELECT "id", "workflow_id", "coordinator_session_id", "status", "inputs", "error", "started_at", "completed_at", "trigger_payload", "scope_type", "scope_kind", "scope_id" FROM `workflow_executions`;--> statement-breakpoint
DROP TABLE `workflow_executions`;--> statement-breakpoint
ALTER TABLE `__new_workflow_executions` RENAME TO `workflow_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_status` ON `workflow_executions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_scope_started` ON `workflow_executions` (`scope_type`,`scope_kind`,`scope_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_workflow_started` ON `workflow_executions` (`workflow_id`,`started_at`);--> statement-breakpoint
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
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_kind` text DEFAULT '' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`cancel_subject` text NOT NULL,
	`context` text NOT NULL,
	`env` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_workflow_run_contexts`("execution_id", "workflow_id", "coordinator_session_id", "source_kind", "source_path", "source_filename", "source_code", "definition_snapshot", "worker_manifest", "inputs", "config", "trigger_payload", "artifact_ref", "execution_hints", "scope_type", "scope_kind", "scope_id", "cancel_subject", "context", "env", "created_at") SELECT "execution_id", "workflow_id", "coordinator_session_id", "source_kind", "source_path", "source_filename", "source_code", "definition_snapshot", "worker_manifest", "inputs", "config", "trigger_payload", "artifact_ref", NULL, "scope_type", "scope_kind", "scope_id", "cancel_subject", "context", "env", "created_at" FROM `workflow_run_contexts`;--> statement-breakpoint
DROP TABLE `workflow_run_contexts`;--> statement-breakpoint
ALTER TABLE `__new_workflow_run_contexts` RENAME TO `workflow_run_contexts`;--> statement-breakpoint
CREATE INDEX `idx_run_contexts_workflow` ON `workflow_run_contexts` (`workflow_id`);
