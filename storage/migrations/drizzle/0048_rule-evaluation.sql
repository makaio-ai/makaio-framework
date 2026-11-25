CREATE TABLE `rule_causes` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_snapshot` text NOT NULL,
	`groups` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`not_before` integer
);
--> statement-breakpoint
CREATE TABLE `rule_evaluation_parts` (
	`key` text PRIMARY KEY NOT NULL,
	`evaluation_id` text NOT NULL,
	`position` integer NOT NULL,
	`reaction` text NOT NULL,
	`parameters` text NOT NULL,
	`item` text,
	`keyed` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`result` text,
	`code` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`not_before` integer,
	`call_started_at` integer,
	`call_deadline` integer,
	FOREIGN KEY (`evaluation_id`) REFERENCES `rule_evaluations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_evaluation_parts_order_idx` ON `rule_evaluation_parts` (`evaluation_id`,`position`);--> statement-breakpoint
CREATE TABLE `rule_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`cause_id` text NOT NULL,
	`rule_id` text,
	`rule_snapshot` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`condition_path` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`cause_id`) REFERENCES `rule_causes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rule_evaluations_cause_idx` ON `rule_evaluations` (`cause_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `rule_evaluations_cause_rule_uq` ON `rule_evaluations` (`cause_id`,`rule_id`) WHERE coalesce("rule_evaluations"."reason", '') <> 'duplicate-rule-id';