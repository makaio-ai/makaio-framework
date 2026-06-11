ALTER TABLE `workflow_executions` ADD `artifact_kind` text;--> statement-breakpoint
ALTER TABLE `workflow_executions` ADD `artifact_id` text;--> statement-breakpoint
CREATE INDEX `idx_workflow_executions_artifact` ON `workflow_executions` (`artifact_kind`,`artifact_id`,`started_at`);