ALTER TABLE `workflow_execution_frames` ADD `output_present` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `workflow_execution_frames` SET `output_present` = 1 WHERE `output` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_gate_instances` ADD `resume_data_present` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `workflow_gate_instances` SET `resume_data_present` = 1 WHERE `resume_data` IS NOT NULL;
