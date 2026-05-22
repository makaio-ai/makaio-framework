CREATE TABLE `client_binary_state` (
	`client_id` text PRIMARY KEY NOT NULL,
	`active_version` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `client_binary_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`version` text NOT NULL,
	`install_path` text NOT NULL,
	`installed_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_client_binary_versions_client_id` ON `client_binary_versions` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_client_binary_versions_client_version` ON `client_binary_versions` (`client_id`,`version`);--> statement-breakpoint
CREATE TABLE `client_runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`status` text NOT NULL,
	`supervisor_session_id` text,
	`pid` integer,
	`parent_pid` integer,
	`adapter_session_id` text,
	`session_id` text,
	`cwd` text,
	`argv` text,
	`metadata` text,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_client_runtimes_supervisor_session_id` ON `client_runtimes` (`supervisor_session_id`);--> statement-breakpoint
CREATE INDEX `idx_client_runtimes_pid_client_id` ON `client_runtimes` (`pid`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_client_runtimes_adapter_session_id_client_id` ON `client_runtimes` (`adapter_session_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `supervisor_runtimes` (
	`supervisor_session_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`pid` integer,
	`status` text NOT NULL,
	`cwd` text NOT NULL,
	`command` text NOT NULL,
	`args_json` text NOT NULL,
	`env_json` text,
	`session_id` text,
	`adapter_session_id` text,
	`started_at` integer NOT NULL,
	`stopped_at` integer,
	`metadata_json` text
);
--> statement-breakpoint
CREATE INDEX `supervisor_runtimes_session_id_idx` ON `supervisor_runtimes` (`session_id`);--> statement-breakpoint
CREATE INDEX `supervisor_runtimes_adapter_session_id_idx` ON `supervisor_runtimes` (`adapter_session_id`);--> statement-breakpoint
CREATE INDEX `supervisor_runtimes_status_idx` ON `supervisor_runtimes` (`status`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`scope` text NOT NULL,
	`surface` text DEFAULT 'any' NOT NULL,
	`context` text DEFAULT 'any' NOT NULL,
	`viewport` text DEFAULT 'any' NOT NULL,
	`category` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_pk` ON `preferences` (`scope`,`surface`,`context`,`viewport`,`category`);--> statement-breakpoint
CREATE TABLE `harness_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`adapter_name` text,
	`client_id` text,
	`env` text,
	`credentials` text,
	`cwd` text,
	`approval_policy` text DEFAULT 'always-ask' NOT NULL,
	`native_tools_enabled` text NOT NULL,
	`native_tools_disabled` text NOT NULL,
	`registry_tools_enabled` text NOT NULL,
	`registry_tools_disabled` text NOT NULL,
	`skills_enabled` text,
	`skills_disabled` text,
	`tool_capability_map` text,
	`capability_overrides` text,
	`tool_approval_overrides` text,
	`is_default` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `adapter_sessions` (
	`adapter_session_id` text PRIMARY KEY NOT NULL,
	`adapter_name` text NOT NULL,
	`parent_adapter_session_id` text,
	`fork_point_message_id` text,
	`session_id` text,
	`model` text,
	`cwd` text,
	`log_file_path` text,
	`kind` text DEFAULT 'root' NOT NULL,
	`discovered_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_sessions_log_file_path` ON `adapter_sessions` (`log_file_path`);--> statement-breakpoint
CREATE TABLE `import_cursors` (
	`file_path` text PRIMARY KEY NOT NULL,
	`bytes_read` integer NOT NULL,
	`last_modified` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_routing` (
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`timestamp` integer NOT NULL,
	`error` text,
	PRIMARY KEY(`message_id`, `agent_id`, `status`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_routing_agent` ON `message_routing` (`agent_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`turn_id` text,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content_text` text NOT NULL,
	`blocks` text DEFAULT '[]' NOT NULL,
	`agent_id` text,
	`adapter_session_id` text,
	`adapter_message_id` text,
	`timestamp` integer NOT NULL,
	`edit_of` text,
	`origin` text,
	FOREIGN KEY (`turn_id`) REFERENCES `turns`(`turn_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`edit_of`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_turn` ON `messages` (`turn_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_agent` ON `messages` (`agent_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_messages_adapter_message_id` ON `messages` (`adapter_message_id`);--> statement-breakpoint
CREATE TABLE `session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`event_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`type` text NOT NULL,
	`agent_id` text,
	`adapter_id` text,
	`originating_message_id` text,
	`message_id` text,
	`turn_id` text,
	`content_text` text,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_event_id_unique` ON `session_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_events_session_ts` ON `session_events` (`session_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_events_session_type` ON `session_events` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_events_turn` ON `session_events` (`turn_id`);--> statement-breakpoint
CREATE INDEX `idx_events_originating_message` ON `session_events` (`originating_message_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_name` text NOT NULL,
	`session_id` text NOT NULL,
	`adapter_session_id` text,
	`model` text,
	`cwd` text,
	`provider_config_id` text,
	`persona_id` text,
	`profile_id` text,
	`harness_id` text,
	`client_id` text,
	`compression_mode` text,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agents_session_id_idx` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `agents_adapter_name_idx` ON `agents` (`adapter_name`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `agents_client_id_idx` ON `agents` (`client_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`status` text NOT NULL,
	`lead_agent_id` text,
	`parent_session_id` text,
	`root_session_id` text,
	`fork_point_message_id` text,
	`branch_kind` text,
	`adapter_name` text,
	`adapter_session_id` text,
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
	`spawning_tool_call_id` text
);
--> statement-breakpoint
CREATE INDEX `sessions_adapter_session_id_idx` ON `sessions` (`adapter_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_execution_target_id_idx` ON `sessions` (`execution_target_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_number` integer NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`error` text,
	`usage` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_turns_session` ON `turns` (`session_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_turns_session_number` ON `turns` (`session_id`,`turn_number`);--> statement-breakpoint
CREATE TABLE `log_import_settings` (
	`adapter_name` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'disabled' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
