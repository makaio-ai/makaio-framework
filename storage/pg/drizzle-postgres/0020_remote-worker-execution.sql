ALTER TABLE "workflow_definitions" ADD COLUMN "executable_source" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD COLUMN "requirements" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_run_contexts" ADD COLUMN "materialization_spec" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_definitions" DROP COLUMN "execution_hints";--> statement-breakpoint
ALTER TABLE "workflow_run_contexts" DROP COLUMN "execution_hints";--> statement-breakpoint
ALTER TABLE "workflow_run_contexts" DROP COLUMN "context";