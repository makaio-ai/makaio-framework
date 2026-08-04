-- Hand-corrected after generation: drizzle-kit's SQLite table rebuild listed the
-- two newly added columns (`current_adapter_session_id`,
-- `current_adapter_session_id_state`) in the copy SELECT as well, which reads them
-- from the pre-migration table where they do not exist yet. They are omitted from
-- both the INSERT and SELECT lists so existing rows adopt NULL plus the
-- 'inherited' default, which is the intended migration semantics. The rebuild
-- itself is required: SQLite cannot ALTER TABLE ADD CONSTRAINT for the new
-- currency check. The generated CHECK constraints qualified their column
-- references with the temporary table name ("__new_sessions"."col"); SQLite
-- versions before 3.53.0 do not rewrite table-qualified CHECK references on
-- ALTER TABLE ... RENAME, so the rename fails with "no such column". The
-- references are unqualified ("col") to stay valid across the rename on every
-- supported SQLite. Paired with drizzle-postgres/0021_adapter_session_currency.sql.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`status` text NOT NULL,
	`lead_agent_id` text,
	`parent_session_id` text,
	`context_inheritance` text,
	`root_session_id` text,
	`fork_point_message_id` text,
	`branch_kind` text,
	`adapter_name` text,
	`adapter_session_id` text,
	`current_adapter_session_id` text,
	`current_adapter_session_id_state` text DEFAULT 'inherited' NOT NULL,
	`adapter_id` text,
	`client_id` text,
	`client_account_id` text,
	`last_client_identity_observation` text,
	`is_orchestrated` integer DEFAULT false,
	`title` text,
	`summary` text,
	`summary_updated_at` integer,
	`is_imported` integer DEFAULT false,
	`fork_transforms` text,
	`target_working_directory` text,
	`execution_target_id` text,
	`approval_policy_override` text,
	`metadata` text,
	`spawning_tool_call_id` text,
	`source` text,
	`parent_external_session_id` text,
	`log_file_path` text,
	`discovered_at` integer,
	`import_status` text,
	`is_sidechain` integer,
	`machine_id` text,
	CONSTRAINT "sessions_import_status_check" CHECK("import_status" IS NULL OR "import_status" IN ('discovered', 'imported', 'tracking')),
	CONSTRAINT "sessions_context_inheritance_check" CHECK("context_inheritance" IS NULL OR "context_inheritance" IN ('parent-history', 'none')),
	CONSTRAINT "sessions_current_adapter_session_id_currency_check" CHECK("current_adapter_session_id_state" IN ('inherited', 'moved', 'confirmed') AND ("current_adapter_session_id_state" <> 'confirmed' OR "current_adapter_session_id" IS NOT NULL) AND ("current_adapter_session_id_state" = 'confirmed' OR "current_adapter_session_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("session_id", "created_at", "last_activity_at", "status", "lead_agent_id", "parent_session_id", "context_inheritance", "root_session_id", "fork_point_message_id", "branch_kind", "adapter_name", "adapter_session_id", "adapter_id", "client_id", "client_account_id", "last_client_identity_observation", "is_orchestrated", "title", "summary", "summary_updated_at", "is_imported", "fork_transforms", "target_working_directory", "execution_target_id", "approval_policy_override", "metadata", "spawning_tool_call_id", "source", "parent_external_session_id", "log_file_path", "discovered_at", "import_status", "is_sidechain", "machine_id") SELECT "session_id", "created_at", "last_activity_at", "status", "lead_agent_id", "parent_session_id", "context_inheritance", "root_session_id", "fork_point_message_id", "branch_kind", "adapter_name", "adapter_session_id", "adapter_id", "client_id", "client_account_id", "last_client_identity_observation", "is_orchestrated", "title", "summary", "summary_updated_at", "is_imported", "fork_transforms", "target_working_directory", "execution_target_id", "approval_policy_override", "metadata", "spawning_tool_call_id", "source", "parent_external_session_id", "log_file_path", "discovered_at", "import_status", "is_sidechain", "machine_id" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sessions_source_adapter_session_id` ON `sessions` (`source`,`adapter_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sessions_log_file_path` ON `sessions` (`log_file_path`);--> statement-breakpoint
CREATE INDEX `sessions_adapter_session_id_idx` ON `sessions` (`adapter_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_import_status` ON `sessions` (`import_status`);--> statement-breakpoint
CREATE INDEX `sessions_execution_target_id_idx` ON `sessions` (`execution_target_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);