CREATE TABLE "workflow_execution_state" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_state_events" (
	"execution_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"patch" jsonb NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "workflow_execution_state_events_execution_id_sequence_pk" PRIMARY KEY("execution_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "workflow_execution_state" ADD CONSTRAINT "workflow_execution_state_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_state_events" ADD CONSTRAINT "workflow_execution_state_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;