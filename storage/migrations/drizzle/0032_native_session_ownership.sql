-- Hand-corrected after generation, for the same reason as
-- 0031_adapter_session_currency.sql: drizzle-kit's SQLite table rebuild listed
-- the four newly added `agents` columns (`current_adapter_session_id`,
-- `current_adapter_session_id_state`, `revision`, `currency_fence`) in the copy
-- SELECT as well, which reads them from the pre-migration table where they do
-- not exist yet. They are omitted from both the INSERT and SELECT lists so
-- existing rows adopt NULL / 'inherited' / 0, which is the intended migration
-- semantics. The rebuild itself is required: SQLite cannot ALTER TABLE ADD
-- CONSTRAINT for the new currency and counter checks.
--
-- The `adapter_session_claims` creation is also moved after the rebuild, so its
-- foreign key never points at a table that the same migration is about to drop.
-- Paired with drizzle-postgres/0022_native_session_ownership.sql.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_name` text NOT NULL,
	`session_id` text NOT NULL,
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
	CONSTRAINT "agents_current_adapter_session_id_currency_check" CHECK("__new_agents"."current_adapter_session_id_state" IN ('inherited', 'moved', 'confirmed') AND ("__new_agents"."current_adapter_session_id_state" <> 'confirmed' OR "__new_agents"."current_adapter_session_id" IS NOT NULL) AND ("__new_agents"."current_adapter_session_id_state" = 'confirmed' OR "__new_agents"."current_adapter_session_id" IS NULL)),
	CONSTRAINT "agents_ownership_counters_check" CHECK("__new_agents"."revision" >= 0 AND "__new_agents"."currency_fence" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_agents`("agent_id", "adapter_id", "adapter_name", "session_id", "adapter_session_id", "model", "cwd", "allowed_directories", "provider_config_id", "persona_id", "profile_id", "harness_id", "client_id", "compression_mode", "role", "status", "created_at", "last_activity_at") SELECT "agent_id", "adapter_id", "adapter_name", "session_id", "adapter_session_id", "model", "cwd", "allowed_directories", "provider_config_id", "persona_id", "profile_id", "harness_id", "client_id", "compression_mode", "role", "status", "created_at", "last_activity_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agents_session_id_idx` ON `agents` (`session_id`);--> statement-breakpoint
CREATE INDEX `agents_adapter_name_idx` ON `agents` (`adapter_name`);--> statement-breakpoint
CREATE INDEX `agents_status_idx` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `agents_client_id_idx` ON `agents` (`client_id`);--> statement-breakpoint
CREATE TABLE `adapter_session_claims` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_name` text NOT NULL,
	`provider_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`claim_token` text NOT NULL,
	`fence` integer NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`claimed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "adapter_session_claims_status_check" CHECK("adapter_session_claims"."status" IN ('held', 'releasing', 'abandoned')),
	CONSTRAINT "adapter_session_claims_fence_check" CHECK("adapter_session_claims"."fence" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_owner` ON `adapter_session_claims` (`machine_id`,`adapter_id`,`provider_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_token` ON `adapter_session_claims` (`claim_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_agent_fence` ON `adapter_session_claims` (`agent_id`,`fence`);--> statement-breakpoint
CREATE INDEX `adapter_session_claims_agent_id_idx` ON `adapter_session_claims` (`agent_id`);--> statement-breakpoint
CREATE INDEX `adapter_session_claims_session_id_idx` ON `adapter_session_claims` (`session_id`);
