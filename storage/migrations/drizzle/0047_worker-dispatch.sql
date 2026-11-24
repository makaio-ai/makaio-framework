CREATE TABLE `worker_allocation_scope_binding` (
	`installation` text PRIMARY KEY NOT NULL,
	`allocation_scope` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`confirmed_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_dispatch` (
	`job_run_id` text PRIMARY KEY NOT NULL,
	`order_digest` text NOT NULL,
	`binding` text NOT NULL,
	`bound_allocation` text,
	`candidates` text NOT NULL,
	`send_settled` integer DEFAULT false NOT NULL,
	`settled` text
);
