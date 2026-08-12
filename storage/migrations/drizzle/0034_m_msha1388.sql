CREATE TABLE `runtime_instances` (
	`instance_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`started_at` integer NOT NULL,
	`retired_at` integer,
	PRIMARY KEY(`instance_id`, `machine_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_runtime_instances_incarnation` ON `runtime_instances` (`machine_id`,`incarnation`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_adapter_session_claims` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`adapter_id` text NOT NULL,
	`adapter_name` text NOT NULL,
	`provider_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`owner_instance_id` text,
	`claim_token` text NOT NULL,
	`fence` integer NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`claimed_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_instance_id`,`machine_id`) REFERENCES `runtime_instances`(`instance_id`,`machine_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "adapter_session_claims_status_check" CHECK("status" IN ('held', 'releasing', 'abandoned')),
	CONSTRAINT "adapter_session_claims_fence_check" CHECK("fence" >= 1)
);
--> statement-breakpoint
INSERT INTO `__new_adapter_session_claims`("claim_id", "machine_id", "adapter_id", "adapter_name", "provider_session_id", "session_id", "agent_id", "claim_token", "fence", "status", "claimed_at", "updated_at") SELECT "claim_id", "machine_id", "adapter_id", "adapter_name", "provider_session_id", "session_id", "agent_id", "claim_token", "fence", "status", "claimed_at", "updated_at" FROM `adapter_session_claims`;--> statement-breakpoint
DROP TABLE `adapter_session_claims`;--> statement-breakpoint
ALTER TABLE `__new_adapter_session_claims` RENAME TO `adapter_session_claims`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_owner` ON `adapter_session_claims` (`machine_id`,`adapter_id`,`provider_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_token` ON `adapter_session_claims` (`claim_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_adapter_session_claims_agent_fence` ON `adapter_session_claims` (`agent_id`,`fence`);--> statement-breakpoint
CREATE INDEX `adapter_session_claims_agent_id_idx` ON `adapter_session_claims` (`agent_id`);--> statement-breakpoint
CREATE INDEX `adapter_session_claims_session_id_idx` ON `adapter_session_claims` (`session_id`);
