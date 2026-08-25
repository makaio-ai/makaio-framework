ALTER TABLE "agents" ADD COLUMN "owner_machine_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_instance_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_owner_pair_check" CHECK (("agents"."owner_machine_id" IS NULL) = ("agents"."owner_instance_id" IS NULL));