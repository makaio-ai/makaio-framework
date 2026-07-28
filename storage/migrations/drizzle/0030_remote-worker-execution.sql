ALTER TABLE `workflow_definitions` ADD `executable_source` text;--> statement-breakpoint
ALTER TABLE `workflow_definitions` ADD `requirements` text;--> statement-breakpoint
ALTER TABLE `workflow_definitions` DROP COLUMN `execution_hints`;--> statement-breakpoint
ALTER TABLE `workflow_run_contexts` ADD `materialization_spec` text;--> statement-breakpoint
ALTER TABLE `workflow_run_contexts` DROP COLUMN `execution_hints`;--> statement-breakpoint
ALTER TABLE `workflow_run_contexts` DROP COLUMN `context`;