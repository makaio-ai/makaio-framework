CREATE TABLE "rule_causes" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_snapshot" jsonb NOT NULL,
	"groups" jsonb NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"not_before" bigint
);
--> statement-breakpoint
CREATE TABLE "rule_evaluation_parts" (
	"key" text PRIMARY KEY NOT NULL,
	"evaluation_id" text NOT NULL,
	"position" integer NOT NULL,
	"reaction" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"item" jsonb,
	"keyed" boolean NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"result" jsonb,
	"code" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"not_before" bigint,
	"call_started_at" bigint,
	"call_deadline" bigint
);
--> statement-breakpoint
CREATE TABLE "rule_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"cause_id" text NOT NULL,
	"rule_id" text,
	"rule_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"condition_path" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rule_evaluation_parts" ADD CONSTRAINT "rule_evaluation_parts_evaluation_id_rule_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "rule_evaluations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_evaluations" ADD CONSTRAINT "rule_evaluations_cause_id_rule_causes_id_fk" FOREIGN KEY ("cause_id") REFERENCES "rule_causes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rule_evaluation_parts_order_idx" ON "rule_evaluation_parts" USING btree ("evaluation_id","position");--> statement-breakpoint
CREATE INDEX "rule_evaluations_cause_idx" ON "rule_evaluations" USING btree ("cause_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_evaluations_cause_rule_uq" ON "rule_evaluations" USING btree ("cause_id","rule_id") WHERE coalesce("rule_evaluations"."reason", '') <> 'duplicate-rule-id';