CREATE TABLE `active_execution_attempt` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`execution_attempt_id` text NOT NULL,
	FOREIGN KEY (`execution_attempt_id`) REFERENCES `execution_attempt`(`execution_attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `execution_attempt_cancellation` (
	`execution_attempt_id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`control_revision` integer NOT NULL,
	`requested_at` text NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `execution_attempt_control_evidence` (
	`execution_attempt_id` text NOT NULL,
	`control_revision` integer NOT NULL,
	`runtime_generation` integer NOT NULL,
	`receipt_json` text,
	`report_json` text,
	PRIMARY KEY(`execution_attempt_id`, `control_revision`, `runtime_generation`)
);
--> statement-breakpoint
CREATE TABLE `execution_attempt_request` (
	`execution_id` text NOT NULL,
	`request_key` text NOT NULL,
	`execution_attempt_id` text NOT NULL,
	PRIMARY KEY(`execution_id`, `request_key`),
	FOREIGN KEY (`execution_attempt_id`) REFERENCES `execution_attempt`(`execution_attempt_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `execution_attempt` (
	`execution_attempt_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`instruction` text NOT NULL,
	`preparation_receipts` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`allocation_lifetime` text,
	`provisioner_incarnation_id` text,
	`allocation_ref` text,
	`settlement_kind` text,
	`outcome_text` text,
	`outcome_control_observation` text,
	`claimable` integer DEFAULT 0 NOT NULL,
	`claim_expires_at` text,
	`created_at` text NOT NULL,
	`bootstrap_deadline_at` text,
	`runtime_generation` integer DEFAULT 0 NOT NULL,
	`runtime_incarnation_id` text,
	`runtime_ready_at` text,
	`operation_start_gate` text DEFAULT 'open' NOT NULL,
	`active_operation_id` text,
	`active_operation_kind` text,
	`active_operation_key` text,
	`active_operation_generation` integer,
	`active_operation_admitted_at` text,
	`last_completed_operation_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_execution_attempt_recovery` ON `execution_attempt` (`execution_id`,`created_at`,`execution_attempt_id`);--> statement-breakpoint
CREATE TABLE `provider_operation` (
	`execution_attempt_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`owner_id` text,
	`token` text,
	`lease_expires_at` text,
	`obligation` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_failure` text,
	`completion_evidence` text,
	FOREIGN KEY (`execution_attempt_id`) REFERENCES `execution_attempt`(`execution_attempt_id`) ON UPDATE no action ON DELETE no action
);
