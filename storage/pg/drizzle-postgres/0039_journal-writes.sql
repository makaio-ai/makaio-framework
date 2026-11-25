CREATE TABLE "journal_writes" (
	"write_record_id" text PRIMARY KEY NOT NULL,
	"writer" text NOT NULL,
	"key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"state" text NOT NULL,
	"version" text NOT NULL,
	"lease_until" bigint NOT NULL,
	"intent_id" text NOT NULL,
	"intent" jsonb NOT NULL,
	"ctx" jsonb NOT NULL,
	"object" jsonb,
	"applied_object" jsonb,
	"object_key" text,
	"parent" jsonb,
	"parent_key" text,
	"checksum" text,
	"applied_order" double precision
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_writes_writer_key_uq" ON "journal_writes" USING btree ("writer","key");--> statement-breakpoint
CREATE INDEX "journal_writes_object_page_idx" ON "journal_writes" USING btree ("object_key","created_at","write_record_id");--> statement-breakpoint
CREATE INDEX "journal_writes_parent_page_idx" ON "journal_writes" USING btree ("parent_key","created_at","write_record_id");