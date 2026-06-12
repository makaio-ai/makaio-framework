ALTER TABLE "messages" ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "idx_messages_content_tsv" ON "messages" USING gin ("content_tsv");
