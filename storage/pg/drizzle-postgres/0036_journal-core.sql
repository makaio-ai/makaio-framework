CREATE TABLE "journal_edge_cursors" (
	"edge" text NOT NULL,
	"partition" text NOT NULL,
	"value" text,
	CONSTRAINT "journal_edge_cursors_pk" PRIMARY KEY("edge","partition")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL,
	"extension" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"schema_version" text NOT NULL,
	"key" text NOT NULL,
	"order_key" text,
	"origin" jsonb NOT NULL,
	"recorded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_position_counter" (
	"id" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "journal_position_counter_singleton_ck" CHECK ("journal_position_counter"."id" = 'journal')
);
--> statement-breakpoint
CREATE TABLE "journal_reader_cursors" (
	"reader" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_reader_states" (
	"reader" text NOT NULL,
	"entry_id" text NOT NULL,
	"position" bigint NOT NULL,
	"order_key" text,
	"state" text NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"not_before" bigint,
	"claim_token" text,
	"claim_expires_at" bigint,
	CONSTRAINT "journal_reader_states_pk" PRIMARY KEY("reader","entry_id"),
	CONSTRAINT "journal_reader_states_state_ck" CHECK ("journal_reader_states"."state" IN ('open', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_position_uq" ON "journal_entries" USING btree ("position");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_extension_key_uq" ON "journal_entries" USING btree ("extension","key");--> statement-breakpoint
CREATE INDEX "journal_entries_subject_position_idx" ON "journal_entries" USING btree ("subject","position");--> statement-breakpoint
CREATE INDEX "journal_reader_states_claim_idx" ON "journal_reader_states" USING btree ("reader","state","position");--> statement-breakpoint
CREATE INDEX "journal_reader_states_order_idx" ON "journal_reader_states" USING btree ("reader","order_key","position");