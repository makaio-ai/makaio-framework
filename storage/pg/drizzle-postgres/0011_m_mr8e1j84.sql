ALTER TABLE "sessions" ADD COLUMN "is_sidechain" boolean;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "turn_anchor_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_turns_session_anchor" ON "turns" USING btree ("session_id","turn_anchor_id");