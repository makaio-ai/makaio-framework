import {
  workflowDefinitionsDual,
  workflowExecutionsDual,
  workflowExecutionFramesDual,
  workflowGateInstancesDual,
  workflowStepSpansDual,
  workflowExecutionLinksDual,
  workflowRunContextsDual,
  worklogSummariesDual,
  worklogFrameEntriesDual,
  worklogArtifactWritesDual,
  worklogGateEventsDual,
} from './schema.js';

/** Postgres face of the `workflow_definitions` table. */
export const workflowDefinitions = workflowDefinitionsDual.postgres;
/** Postgres face of the `workflow_executions` table. */
export const workflowExecutions = workflowExecutionsDual.postgres;
/** Postgres face of the `workflow_execution_frames` table. */
export const workflowExecutionFrames = workflowExecutionFramesDual.postgres;
/** Postgres face of the `workflow_gate_instances` table. */
export const workflowGateInstances = workflowGateInstancesDual.postgres;
/** Postgres face of the `workflow_step_spans` table. */
export const workflowStepSpans = workflowStepSpansDual.postgres;
/** Postgres face of the `workflow_execution_links` table. */
export const workflowExecutionLinks = workflowExecutionLinksDual.postgres;
/** Postgres face of the `workflow_run_contexts` table. */
export const workflowRunContexts = workflowRunContextsDual.postgres;
/** Postgres face of the `worklog_summaries` table. */
export const worklogSummaries = worklogSummariesDual.postgres;
/** Postgres face of the `worklog_frame_entries` table. */
export const worklogFrameEntries = worklogFrameEntriesDual.postgres;
/** Postgres face of the `worklog_artifact_writes` table. */
export const worklogArtifactWrites = worklogArtifactWritesDual.postgres;
/** Postgres face of the `worklog_gate_events` table. */
export const worklogGateEvents = worklogGateEventsDual.postgres;
