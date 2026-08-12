CREATE TABLE "runtime_instances" (
	"instance_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"incarnation" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"retired_at" bigint,
	CONSTRAINT "runtime_instances_instance_id_machine_id_pk" PRIMARY KEY("instance_id","machine_id")
);
--> statement-breakpoint
ALTER TABLE "adapter_session_claims" ADD COLUMN "owner_instance_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_runtime_instances_incarnation" ON "runtime_instances" USING btree ("machine_id","incarnation");--> statement-breakpoint
ALTER TABLE "adapter_session_claims" ADD CONSTRAINT "adapter_session_claims_owner_instance_id_machine_id_runtime_instances_instance_id_machine_id_fk" FOREIGN KEY ("owner_instance_id","machine_id") REFERENCES "runtime_instances"("instance_id","machine_id") ON DELETE restrict ON UPDATE no action;