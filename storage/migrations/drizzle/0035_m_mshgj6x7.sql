PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_name` text NOT NULL,
	`session_id` text NOT NULL,
	`owner_machine_id` text,
	`owner_instance_id` text,
	`adapter_session_id` text,
	`current_adapter_session_id` text,
	`current_adapter_session_id_state` text DEFAULT 'inherited' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`currency_fence` integer DEFAULT 0 NOT NULL,
	`model` text,
	`cwd` text,
	`allowed_directories` text,
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
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agents_current_adapter_session_id_currency_check" CHECK("current_adapter_session_id_state" IN ('inherited', 'moved', 'confirmed') AND ("current_adapter_session_id_state" <> 'confirmed' OR "current_adapter_session_id" IS NOT NULL) AND ("current_adapter_session_id_state" = 'confirmed' OR "current_adapter_session_id" IS NULL)),
	CONSTRAINT "agents_ownership_counters_check" CHECK("revision" >= 0 AND "currency_fence" >= 0),
	CONSTRAINT "agents_runtime_owner_pair_check" CHECK(("owner_machine_id" IS NULL) = ("owner_instance_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_agents`("agent_id", "adapter_id", "adapter_name", "session_id", "owner_machine_id", "owner_instance_id", "adapter_session_id", "current_adapter_session_id", "current_adapter_session_id_state", "revision", "currency_fence", "model", "cwd", "allowed_directories", "provider_config_id", "persona_id", "profile_id", "harness_id", "client_id", "compression_mode", "role", "status", "created_at", "last_activity_at") SELECT "agent_id", "adapter_id", "adapter_name", "session_id", NULL, NULL, "adapter_session_id", "current_adapter_session_id", "current_adapter_session_id_state", "revision", "currency_fence", "model", "cwd", "allowed_directories", "provider_config_id", "persona_id", "profile_id", "harness_id", "client_id", "compression_mode", "role", "status", "created_at", "last_activity_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agents_session_id_idx` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `agents_adapter_name_idx` ON `agents` (`adapter_name`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `agents_client_id_idx` ON `agents` (`client_id`);
