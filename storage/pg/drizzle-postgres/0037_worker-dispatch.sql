CREATE TABLE "worker_allocation_scope_binding" (
	"installation" text PRIMARY KEY NOT NULL,
	"allocation_scope" text NOT NULL,
	"confirmed_at" text NOT NULL,
	"confirmed_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_dispatch" (
	"job_run_id" text PRIMARY KEY NOT NULL,
	"order_digest" text NOT NULL,
	"binding" jsonb NOT NULL,
	"bound_allocation" jsonb,
	"candidates" jsonb NOT NULL,
	"send_settled" boolean DEFAULT false NOT NULL,
	"settled" jsonb
);
