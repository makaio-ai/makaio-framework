ALTER TABLE "agents" ADD COLUMN "allowed_tools" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "disallowed_tools" jsonb;