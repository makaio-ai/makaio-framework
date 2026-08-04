-- The agents CHECK constraints are added plainly (not NOT VALID + VALIDATE):
-- the split only shortens the ACCESS EXCLUSIVE window on large existing
-- tables, and this migration targets pre-release deployments where agents is
-- small or empty. Splitting would also make the Postgres chain diverge from
-- the SQLite rebuild's semantics for no runtime benefit.
CREATE TABLE "adapter_session_claims" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"adapter_id" text NOT NULL,
	"adapter_name" text NOT NULL,
	"provider_session_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"claim_token" text NOT NULL,
	"fence" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"claimed_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "adapter_session_claims_status_check" CHECK ("adapter_session_claims"."status" IN ('held', 'releasing', 'abandoned')),
	CONSTRAINT "adapter_session_claims_fence_check" CHECK ("adapter_session_claims"."fence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "current_adapter_session_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "current_adapter_session_id_state" text DEFAULT 'inherited' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "currency_fence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_session_claims" ADD CONSTRAINT "adapter_session_claims_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_session_claims" ADD CONSTRAINT "adapter_session_claims_agent_id_agents_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_adapter_session_claims_owner" ON "adapter_session_claims" USING btree ("machine_id","adapter_id","provider_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_adapter_session_claims_token" ON "adapter_session_claims" USING btree ("claim_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_adapter_session_claims_agent_fence" ON "adapter_session_claims" USING btree ("agent_id","fence");--> statement-breakpoint
CREATE INDEX "adapter_session_claims_agent_id_idx" ON "adapter_session_claims" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "adapter_session_claims_session_id_idx" ON "adapter_session_claims" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_current_adapter_session_id_currency_check" CHECK ("agents"."current_adapter_session_id_state" IN ('inherited', 'moved', 'confirmed') AND ("agents"."current_adapter_session_id_state" <> 'confirmed' OR "agents"."current_adapter_session_id" IS NOT NULL) AND ("agents"."current_adapter_session_id_state" = 'confirmed' OR "agents"."current_adapter_session_id" IS NULL));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_ownership_counters_check" CHECK ("agents"."revision" >= 0 AND "agents"."currency_fence" >= 0);