-- Pre-release clean cut: reset existing development databases before applying
-- this chain. The private allocator intentionally does not backfill prior rows.
CREATE TABLE "runtime_instance_incarnation_counters" (
	"machine_id" text PRIMARY KEY NOT NULL,
	"last_allocated_incarnation" integer NOT NULL
);
