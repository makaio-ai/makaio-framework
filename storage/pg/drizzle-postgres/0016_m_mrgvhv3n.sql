CREATE TABLE "workflow_finalizations" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"finalizer_id" text NOT NULL,
	"transition_key" text NOT NULL,
	"claim_token" text NOT NULL,
	"intent" jsonb NOT NULL,
	"state" text NOT NULL,
	"claimed_at" bigint NOT NULL,
	"settled_at" bigint,
	"failure" text
);
--> statement-breakpoint
ALTER TABLE "workflow_finalizations" ADD CONSTRAINT "workflow_finalizations_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workflow_finalizations_transition" ON "workflow_finalizations" USING btree ("transition_key");--> statement-breakpoint
CREATE INDEX "idx_workflow_finalizations_recovery" ON "workflow_finalizations" USING btree ("finalizer_id","state");