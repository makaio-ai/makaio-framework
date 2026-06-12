ALTER TABLE "workflow_executions" ADD COLUMN "artifact_kind" text;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "artifact_id" text;--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_artifact" ON "workflow_executions" USING btree ("artifact_kind","artifact_id","started_at");