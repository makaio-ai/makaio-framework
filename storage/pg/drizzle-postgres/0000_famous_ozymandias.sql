CREATE TABLE "preferences" (
	"scope" text NOT NULL,
	"surface" text DEFAULT 'any' NOT NULL,
	"context" text DEFAULT 'any' NOT NULL,
	"viewport" text DEFAULT 'any' NOT NULL,
	"category" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"adapter_name" text,
	"client_id" text,
	"env" jsonb,
	"credentials" jsonb,
	"cwd" text,
	"approval_policy" text DEFAULT 'always-ask' NOT NULL,
	"native_tools_enabled" jsonb NOT NULL,
	"native_tools_disabled" jsonb NOT NULL,
	"registry_tools_enabled" jsonb NOT NULL,
	"registry_tools_disabled" jsonb NOT NULL,
	"skills_enabled" jsonb,
	"skills_disabled" jsonb,
	"tool_capability_map" jsonb,
	"capability_overrides" jsonb,
	"tool_approval_overrides" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_cursors" (
	"file_path" text PRIMARY KEY NOT NULL,
	"bytes_read" integer NOT NULL,
	"last_modified" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_routing" (
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"error" text,
	CONSTRAINT "message_routing_message_id_agent_id_status_pk" PRIMARY KEY("message_id","agent_id","status")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"turn_id" text,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content_text" text NOT NULL,
	"blocks" text DEFAULT '[]' NOT NULL,
	"agent_id" text,
	"adapter_session_id" text,
	"adapter_message_id" text,
	"timestamp" bigint NOT NULL,
	"edit_of" text,
	"origin" text
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" text NOT NULL,
	"event_id" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"type" text NOT NULL,
	"agent_id" text,
	"adapter_id" text,
	"originating_message_id" text,
	"message_id" text,
	"turn_id" text,
	"content_text" text,
	"payload" text NOT NULL,
	CONSTRAINT "session_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"adapter_id" text NOT NULL,
	"adapter_name" text NOT NULL,
	"session_id" text NOT NULL,
	"adapter_session_id" text,
	"model" text,
	"cwd" text,
	"provider_config_id" text,
	"persona_id" text,
	"profile_id" text,
	"harness_id" text,
	"client_id" text,
	"compression_mode" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint NOT NULL,
	"status" text NOT NULL,
	"lead_agent_id" text,
	"parent_session_id" text,
	"context_inheritance" text,
	"root_session_id" text,
	"fork_point_message_id" text,
	"branch_kind" text,
	"adapter_name" text,
	"adapter_session_id" text,
	"adapter_id" text,
	"client_id" text,
	"client_account_id" text,
	"last_client_identity_observation" text,
	"is_orchestrated" boolean DEFAULT false,
	"title" text,
	"summary" text,
	"summary_updated_at" bigint,
	"is_imported" boolean DEFAULT false,
	"fork_transforms" text,
	"target_working_directory" text,
	"execution_target_id" text,
	"approval_policy_override" text,
	"spawning_tool_call_id" text,
	"source" text,
	"parent_external_session_id" text,
	"log_file_path" text,
	"discovered_at" bigint,
	"import_status" text,
	CONSTRAINT "sessions_import_status_check" CHECK ("sessions"."import_status" IS NULL OR "sessions"."import_status" IN ('discovered', 'imported', 'tracking')),
	CONSTRAINT "sessions_context_inheritance_check" CHECK ("sessions"."context_inheritance" IS NULL OR "sessions"."context_inheritance" IN ('parent-history', 'none'))
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"turn_number" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"status" text NOT NULL,
	"error" text,
	"usage" text
);
--> statement-breakpoint
CREATE TABLE "log_import_settings" (
	"adapter_name" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'disabled' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_binary_state" (
	"client_id" text PRIMARY KEY NOT NULL,
	"active_version" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_binary_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"version" text NOT NULL,
	"install_path" text NOT NULL,
	"installed_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "uq_client_binary_versions_client_version" UNIQUE("client_id","version")
);
--> statement-breakpoint
CREATE TABLE "client_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"config_dir" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_runtimes" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"status" text NOT NULL,
	"supervisor_session_id" text,
	"pid" integer,
	"parent_pid" integer,
	"adapter_session_id" text,
	"session_id" text,
	"cwd" text,
	"argv" jsonb,
	"metadata" jsonb,
	"observed_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supervisor_runtimes" (
	"supervisor_session_id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"pid" integer,
	"status" text NOT NULL,
	"cwd" text NOT NULL,
	"command" text NOT NULL,
	"args_json" text NOT NULL,
	"env_json" text,
	"session_id" text,
	"adapter_session_id" text,
	"started_at" bigint NOT NULL,
	"stopped_at" bigint,
	"metadata_json" text
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"root" jsonb NOT NULL,
	"input_schema" jsonb,
	"config_schema" jsonb,
	"output_schema" jsonb,
	"artifact" jsonb,
	"triggers" jsonb,
	"scope_type" text NOT NULL,
	"scope_kind" text DEFAULT '' NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"canvas_layout" jsonb,
	"source" jsonb,
	"execution_hints" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_frames" (
	"frame_id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"path" jsonb NOT NULL,
	"parent_frame_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"iteration" integer,
	"branch_key" text,
	"output" jsonb,
	"output_present" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" bigint,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_links" (
	"source_execution_id" text NOT NULL,
	"target_execution_id" text NOT NULL,
	"link_type" text NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "workflow_execution_links_source_execution_id_target_execution_id_pk" PRIMARY KEY("source_execution_id","target_execution_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"coordinator_session_id" text,
	"status" text NOT NULL,
	"inputs" jsonb,
	"error" text,
	"reason" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"trigger_payload" jsonb,
	"scope_type" text NOT NULL,
	"scope_kind" text DEFAULT '' NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_gate_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"schema" jsonb NOT NULL,
	"prompt" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"auto_action" text DEFAULT 'reject' NOT NULL,
	"timeout_ms" integer,
	"resume_data" jsonb,
	"resume_data_present" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE TABLE "workflow_run_contexts" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"coordinator_session_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_path" text,
	"source_filename" text,
	"source_code" text,
	"definition_snapshot" jsonb,
	"worker_manifest" jsonb NOT NULL,
	"inputs" jsonb,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"trigger_payload" jsonb NOT NULL,
	"artifact_ref" jsonb,
	"execution_hints" jsonb,
	"dispatch_metadata" jsonb,
	"scope_type" text DEFAULT 'global' NOT NULL,
	"scope_kind" text DEFAULT '' NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"cancel_subject" text NOT NULL,
	"context" jsonb NOT NULL,
	"env" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"suspension_strategy" text
);
--> statement-breakpoint
CREATE TABLE "workflow_step_spans" (
	"execution_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"step_id" text NOT NULL,
	"step_type" text NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost" double precision,
	"tool_call_count" integer,
	"input" text,
	"output" text,
	CONSTRAINT "workflow_step_spans_execution_id_frame_id_pk" PRIMARY KEY("execution_id","frame_id")
);
--> statement-breakpoint
CREATE TABLE "worklog_artifact_writes" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"node_id" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"revision" text,
	"written_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worklog_frame_entries" (
	"frame_id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"path" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"iteration" integer,
	"branch_key" text,
	"started_at" bigint,
	"completed_at" bigint,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost" double precision,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "worklog_gate_events" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"status" text NOT NULL,
	"prompt" text,
	"opened_at" bigint NOT NULL,
	"resolved_at" bigint,
	"resume_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "worklog_summaries" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_name" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"duration_ms" integer,
	"total_input_tokens" integer,
	"total_output_tokens" integer,
	"total_estimated_cost" double precision,
	"error" text,
	"failed_node_id" text
);
--> statement-breakpoint
ALTER TABLE "message_routing" ADD CONSTRAINT "message_routing_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_id_turns_turn_id_fk" FOREIGN KEY ("turn_id") REFERENCES "turns"("turn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_edit_of_messages_message_id_fk" FOREIGN KEY ("edit_of") REFERENCES "messages"("message_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_message_id_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_frames" ADD CONSTRAINT "workflow_execution_frames_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_links" ADD CONSTRAINT "workflow_execution_links_source_execution_id_workflow_executions_id_fk" FOREIGN KEY ("source_execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_links" ADD CONSTRAINT "workflow_execution_links_target_execution_id_workflow_executions_id_fk" FOREIGN KEY ("target_execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_gate_instances" ADD CONSTRAINT "workflow_gate_instances_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_spans" ADD CONSTRAINT "workflow_step_spans_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_artifact_writes" ADD CONSTRAINT "worklog_artifact_writes_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_frame_entries" ADD CONSTRAINT "worklog_frame_entries_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worklog_gate_events" ADD CONSTRAINT "worklog_gate_events_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_pk" ON "preferences" USING btree ("scope","surface","context","viewport","category");--> statement-breakpoint
CREATE INDEX "idx_routing_agent" ON "message_routing" USING btree ("agent_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_session" ON "messages" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_turn" ON "messages" USING btree ("turn_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_agent" ON "messages" USING btree ("agent_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_messages_adapter_message_id" ON "messages" USING btree ("adapter_message_id");--> statement-breakpoint
CREATE INDEX "idx_events_session_ts" ON "session_events" USING btree ("session_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_events_session_type" ON "session_events" USING btree ("session_id","type");--> statement-breakpoint
CREATE INDEX "idx_events_turn" ON "session_events" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "idx_events_originating_message" ON "session_events" USING btree ("originating_message_id");--> statement-breakpoint
CREATE INDEX "agents_session_id_idx" ON "agents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agents_adapter_name_idx" ON "agents" USING btree ("adapter_name");--> statement-breakpoint
CREATE INDEX "agents_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agents_client_id_idx" ON "agents" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sessions_source_adapter_session_id" ON "sessions" USING btree ("source","adapter_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sessions_log_file_path" ON "sessions" USING btree ("log_file_path");--> statement-breakpoint
CREATE INDEX "sessions_adapter_session_id_idx" ON "sessions" USING btree ("adapter_session_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_import_status" ON "sessions" USING btree ("import_status");--> statement-breakpoint
CREATE INDEX "sessions_execution_target_id_idx" ON "sessions" USING btree ("execution_target_id");--> statement-breakpoint
CREATE INDEX "idx_turns_session" ON "turns" USING btree ("session_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_turns_session_number" ON "turns" USING btree ("session_id","turn_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_profiles_client_name" ON "client_profiles" USING btree ("client_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_profiles_default" ON "client_profiles" USING btree ("client_id") WHERE "client_profiles"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_client_runtimes_supervisor_session_id" ON "client_runtimes" USING btree ("supervisor_session_id");--> statement-breakpoint
CREATE INDEX "idx_client_runtimes_pid_client_id" ON "client_runtimes" USING btree ("pid","client_id");--> statement-breakpoint
CREATE INDEX "idx_client_runtimes_adapter_session_id_client_id" ON "client_runtimes" USING btree ("adapter_session_id","client_id");--> statement-breakpoint
CREATE INDEX "supervisor_runtimes_session_id_idx" ON "supervisor_runtimes" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "supervisor_runtimes_adapter_session_id_idx" ON "supervisor_runtimes" USING btree ("adapter_session_id");--> statement-breakpoint
CREATE INDEX "supervisor_runtimes_status_idx" ON "supervisor_runtimes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_workflow_definitions_name_scope" ON "workflow_definitions" USING btree ("name","scope_type","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_definitions_scope" ON "workflow_definitions" USING btree ("scope_type","scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_frames_execution" ON "workflow_execution_frames" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_frames_parent" ON "workflow_execution_frames" USING btree ("parent_frame_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_links_target" ON "workflow_execution_links" USING btree ("target_execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_status" ON "workflow_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_scope_started" ON "workflow_executions" USING btree ("scope_type","scope_kind","scope_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_workflow_started" ON "workflow_executions" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_gate_instances_execution" ON "workflow_gate_instances" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_gate_instances_frame" ON "workflow_gate_instances" USING btree ("frame_id");--> statement-breakpoint
CREATE INDEX "idx_run_contexts_workflow" ON "workflow_run_contexts" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_step_spans_status" ON "workflow_step_spans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_worklog_artifact_writes_execution" ON "worklog_artifact_writes" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_worklog_frame_entries_execution" ON "worklog_frame_entries" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_worklog_gate_events_execution" ON "worklog_gate_events" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_worklog_gate_events_status" ON "worklog_gate_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_worklog_summaries_workflow_started" ON "worklog_summaries" USING btree ("workflow_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_worklog_summaries_status" ON "worklog_summaries" USING btree ("status");