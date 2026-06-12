ALTER TABLE "import_cursors" ALTER COLUMN "bytes_read" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "idx_sessions_parent_session_id" ON "sessions" USING btree ("parent_session_id");