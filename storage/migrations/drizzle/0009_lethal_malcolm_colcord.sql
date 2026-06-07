-- Existing rows predate persisted gate timeout policy. The migration can make
-- those rows schema-valid, but it cannot reconstruct the original runtime
-- autoAction/timeoutMs for already-open gates; pre-release databases should
-- restart or discard in-flight parked executions across this migration.
ALTER TABLE `workflow_gate_instances` ADD `auto_action` text DEFAULT 'reject' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_gate_instances` ADD `timeout_ms` integer;
