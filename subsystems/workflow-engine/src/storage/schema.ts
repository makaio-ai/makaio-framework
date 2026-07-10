/* eslint max-lines: ["error", { "max": 500, "skipBlankLines": true, "skipComments": true }] */
import { sql } from 'drizzle-orm';
import { uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { uniqueIndex as pgUniqueIndex, index as pgIndex, primaryKey as pgPrimaryKey } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import type {
  WorkflowDefinition,
  WorkflowExecutionScope,
  WorkflowFrameState,
  WorkflowGateInstance,
  WorkflowTrigger,
  ExecutionLinkType,
  SpanStatus,
  WorkerContributionManifest,
  JsonValue,
  WorkflowNodeType,
  WorkflowArtifactBinding,
  WorkflowRunContext,
  WorkLogGateEvent,
  ExecutionHints,
  WorkflowDefinitionProvenance,
  JsonPatchOperation,
} from '@makaio/contracts';
import type { DualColumnBundle } from '@makaio/storage-drizzle';

/**
 * Scope columns shared by `workflowDefinitions` and `workflowExecutions`.
 * Returns DualBuilders for use inside a `defineDualTable` colsFn.
 * @param c - The dual column bundle provided by `defineDualTable`.
 * @returns Column definitions for `scopeType`, `scopeKind`, and `scopeId`.
 */
function scopeColumns(c: DualColumnBundle) {
  return {
    scopeType: c
      .textEnum('scope_type', { enum: ['global', 'workspace', 'session', 'external'] as const })
      .notNull()
      .$type<WorkflowExecutionScope['type']>(),
    scopeKind: c.text('scope_kind').notNull().default(''),
    scopeId: c.text('scope_id').notNull().default(''),
  } as const;
}

/**
 * Workflow definitions table.
 * Stores pipeline-primitive workflow definitions with a `root` sequence node tree.
 */
export const workflowDefinitionsDual = defineDualTable(
  'workflow_definitions',
  (c) => ({
    /** Unique workflow identifier. */
    id: c.text('id').primaryKey(),
    /** Workflow name. */
    name: c.text('name').notNull(),
    /** Human-readable description. */
    description: c.text('description'),
    /**
     * Root sequence node tree (JSON).
     * Replaces the old flat `steps` DAG with a structured `WorkflowSequenceNode` tree.
     */
    root: c.jsonCol<WorkflowDefinition['root']>('root').notNull(),
    /** JSON Schema for workflow input parameters (JSON object). */
    inputSchema: c.jsonCol<Record<string, JsonValue>>('input_schema'),
    /** JSON Schema for static workflow configuration (JSON object). */
    configSchema: c.jsonCol<Record<string, JsonValue>>('config_schema'),
    /** JSON Schema for the workflow's primary output (JSON object). */
    outputSchema: c.jsonCol<Record<string, JsonValue>>('output_schema'),
    /** Optional state contract for run-scoped mutable state (JSON object). */
    state: c.jsonCol<NonNullable<WorkflowDefinition['state']>>('state'),
    /** Primary artifact binding declared by the workflow (JSON object). */
    artifact: c.jsonCol<WorkflowDefinition['artifact']>('artifact'),
    /** Trigger configuration (JSON array). Null means manual-only default. */
    triggers: c.jsonCol<WorkflowTrigger[]>('triggers'),
    ...scopeColumns(c),
    /** Creation timestamp. */
    createdAt: c.epochMs('created_at').notNull(),
    /** Last update timestamp. */
    updatedAt: c.epochMs('updated_at').notNull(),
    /** Canvas layout hints for the visual editor (JSON object). */
    canvasLayout: c.jsonCol<Record<string, JsonValue>>('canvas_layout'),
    /**
     * Provenance record for extension-synced definitions (JSON).
     * Absent on locally-authored definitions.
     */
    source: c.jsonCol<WorkflowDefinitionProvenance>('source'),
    /**
     * Advisory execution hints for worker provisioning (JSON).
     * Merged with per-call hints at execution start.
     */
    executionHints: c.jsonCol<ExecutionHints>('execution_hints'),
  }),
  {
    sqlite: (t) => [
      // (name, scopeType, scopeKind, scopeId) unique to prevent duplicate names per scope.
      uniqueIndex('uniq_workflow_definitions_name_scope').on(t.name, t.scopeType, t.scopeKind, t.scopeId),
      // Index on scope columns for efficient filtering.
      index('idx_workflow_definitions_scope').on(t.scopeType, t.scopeKind, t.scopeId),
    ],
    postgres: (t) => [
      pgUniqueIndex('uniq_workflow_definitions_name_scope').on(t.name, t.scopeType, t.scopeKind, t.scopeId),
      pgIndex('idx_workflow_definitions_scope').on(t.scopeType, t.scopeKind, t.scopeId),
    ],
  },
);

/** SQLite face of the `workflow_definitions` table (canonical schema). */
export const workflowDefinitions = workflowDefinitionsDual.sqlite;

export type InsertWorkflowDefinition = typeof workflowDefinitions.$inferInsert;
export type SelectWorkflowDefinition = typeof workflowDefinitions.$inferSelect;

/**
 * Workflow executions table.
 * Stores runtime state of workflow executions.
 */
export const workflowExecutionsDual = defineDualTable(
  'workflow_executions',
  (c) => ({
    /** Unique execution identifier. */
    id: c.text('id').primaryKey(),
    /** Workflow definition or ephemeral source execution identifier. */
    workflowId: c.text('workflow_id').notNull(),
    /** Coordinator session ID for this execution. */
    coordinatorSessionId: c.text('coordinator_session_id'),
    /** Current execution status. */
    status: c
      .textEnum('status', { enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const })
      .notNull(),
    /** Bound workflow input value (JSON). */
    inputs: c.jsonCol<JsonValue>('inputs'),
    /** Error message if execution failed. */
    error: c.text('error'),
    /** Cancellation reason if execution was cancelled. */
    reason: c.text('reason'),
    /** Execution start timestamp. */
    startedAt: c.epochMs('started_at').notNull(),
    /** Execution completion timestamp. */
    completedAt: c.epochMs('completed_at'),
    /** Canonical identity of an authoritative external settlement, when present. */
    externalSettlementFingerprint: c.text('external_settlement_fingerprint'),
    /** Frame durably bound by external registration; null means registration had no frame. */
    externalRegistrationFrameId: c.text('external_registration_frame_id'),
    /** Trigger payload from the firing trigger (JSON object). */
    triggerPayload: c.jsonCol<Record<string, JsonValue>>('trigger_payload'),
    /** Artifact kind the execution is bound to (flat for indexed filtering). */
    artifactKind: c.text('artifact_kind'),
    /** Artifact identifier within its kind. */
    artifactId: c.text('artifact_id'),
    ...scopeColumns(c),
  }),
  {
    sqlite: (t) => [
      // Index on status for efficient filtering.
      index('idx_workflow_executions_status').on(t.status),
      // Index on scope columns + startedAt for bounded scope listing with ordering.
      index('idx_workflow_executions_scope_started').on(t.scopeType, t.scopeKind, t.scopeId, t.startedAt),
      // Index on workflowId + startedAt for per-workflow listing with ordering.
      index('idx_workflow_executions_workflow_started').on(t.workflowId, t.startedAt),
      // Index for artifact-bound execution listing with ordering.
      index('idx_workflow_executions_artifact').on(t.artifactKind, t.artifactId, t.startedAt),
    ],
    postgres: (t) => [
      pgIndex('idx_workflow_executions_status').on(t.status),
      pgIndex('idx_workflow_executions_scope_started').on(t.scopeType, t.scopeKind, t.scopeId, t.startedAt),
      pgIndex('idx_workflow_executions_workflow_started').on(t.workflowId, t.startedAt),
      pgIndex('idx_workflow_executions_artifact').on(t.artifactKind, t.artifactId, t.startedAt),
    ],
  },
);

/** SQLite face of the `workflow_executions` table (canonical schema). */
export const workflowExecutions = workflowExecutionsDual.sqlite;

export type InsertWorkflowExecution = typeof workflowExecutions.$inferInsert;
export type SelectWorkflowExecution = typeof workflowExecutions.$inferSelect;

/**
 * Workflow execution frames table.
 *
 * Each node in the pipeline tree gets a frame per execution pass. Child nodes
 * (sequence, parallel, iterate) create child frames. The `path` column encodes
 * the frame's position in the tree for log correlation and UI display.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowExecutionFramesDual = defineDualTable(
  'workflow_execution_frames',
  (c) => ({
    /** Unique frame identifier within the execution. */
    frameId: c.text('frame_id').primaryKey(),
    /** Execution this frame belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Node identifier from the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Node type discriminant for routing and display. */
    nodeType: c.text('node_type').notNull().$type<WorkflowFrameState['nodeType']>(),
    /**
     * Ordered path of frame IDs from the root frame to this frame (inclusive).
     * Used for tree traversal, log correlation, and UI breadcrumb display.
     */
    path: c.jsonCol<string[]>('path').notNull(),
    /** Parent frame ID. Absent for the root frame. */
    parentFrameId: c.text('parent_frame_id'),
    /** Current frame execution status. */
    status: c.text('status').notNull().default('pending').$type<WorkflowFrameState['status']>(),
    /**
     * Number of execution attempts for this frame (zero-based).
     * Incremented each time the frame is retried after failure.
     */
    attempt: c.int4('attempt').notNull().default(0),
    /**
     * Zero-based iteration index when this frame belongs to an `iterate` or
     * `iterate-chain` expansion. Absent for non-iteration frames.
     */
    iteration: c.int4('iteration'),
    /**
     * Branch key when this frame is a child of a `parallel` node.
     * Matches a key in `WorkflowParallelNode.branches`.
     */
    branchKey: c.text('branch_key'),
    /** JSON-serializable output produced by the node on completion. */
    output: c.jsonCol<JsonValue>('output'),
    /** Whether `output` was explicitly produced, including JSON null. */
    outputPresent: c.bool('output_present').notNull().default(false),
    /** Human-readable error message when status is `failed`. */
    error: c.text('error'),
    /** Epoch milliseconds when the frame started executing. */
    startedAt: c.epochMs('started_at'),
    /** Epoch milliseconds when the frame reached a terminal status. */
    completedAt: c.epochMs('completed_at'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution frame lookup.
      index('idx_workflow_execution_frames_execution').on(t.executionId),
      // Parent-frame traversal.
      index('idx_workflow_execution_frames_parent').on(t.parentFrameId),
    ],
    postgres: (t) => [
      pgIndex('idx_workflow_execution_frames_execution').on(t.executionId),
      pgIndex('idx_workflow_execution_frames_parent').on(t.parentFrameId),
    ],
  },
);

/** SQLite face of the `workflow_execution_frames` table (canonical schema). */
export const workflowExecutionFrames = workflowExecutionFramesDual.sqlite;

export type InsertWorkflowExecutionFrame = typeof workflowExecutionFrames.$inferInsert;
export type SelectWorkflowExecutionFrame = typeof workflowExecutionFrames.$inferSelect;

/**
 * Workflow gate instances table.
 *
 * Created when a gate node is entered, updated when the gate is resolved,
 * timed out, or cancelled. Stored independently of frame state so the gate
 * service can query open gates without scanning the full frame tree.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowGateInstancesDual = defineDualTable(
  'workflow_gate_instances',
  (c) => ({
    /** Unique gate instance identifier. */
    id: c.text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Node ID of the gate in the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Frame ID of the gate's execution frame. */
    frameId: c.text('frame_id').notNull(),
    /**
     * JSON Schema describing the expected resume data payload.
     * Callers must satisfy this schema when responding to the gate.
     */
    schema: c.jsonCol<Record<string, unknown>>('schema').notNull(),
    /**
     * Optional prompt shown to the reviewer after template interpolation.
     * Populated from the gate node's `prompt` field at execution time.
     */
    prompt: c.text('prompt'),
    /** Current gate status. */
    status: c.text('status').notNull().default('waiting').$type<WorkflowGateInstance['status']>(),
    /** Effective timeout action captured when the gate opened. */
    autoAction: c
      .textEnum('auto_action', { enum: ['approve', 'reject'] as const })
      .notNull()
      .default('reject'),
    /** Effective timeout in milliseconds captured when the gate opened. */
    timeoutMs: c.int4('timeout_ms'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: c.jsonCol<JsonValue>('resume_data'),
    /** Human-readable rationale supplied by the responder. */
    reason: c.text('reason'),
    /** Whether `resume_data` was explicitly submitted, including JSON null. */
    resumeDataPresent: c.bool('resume_data_present').notNull().default(false),
    /** Epoch milliseconds when the gate was created (node entered). */
    createdAt: c.epochMs('created_at').notNull(),
    /** Epoch milliseconds when the gate left the `waiting` status. */
    resolvedAt: c.epochMs('resolved_at'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution gate lookup.
      index('idx_workflow_gate_instances_execution').on(t.executionId),
      // Frame-based gate lookup for iterate-expanded gates.
      index('idx_workflow_gate_instances_frame').on(t.frameId),
    ],
    postgres: (t) => [
      pgIndex('idx_workflow_gate_instances_execution').on(t.executionId),
      pgIndex('idx_workflow_gate_instances_frame').on(t.frameId),
    ],
  },
);

/** SQLite face of the `workflow_gate_instances` table (canonical schema). */
export const workflowGateInstances = workflowGateInstancesDual.sqlite;

export type InsertWorkflowGateInstance = typeof workflowGateInstances.$inferInsert;
export type SelectWorkflowGateInstance = typeof workflowGateInstances.$inferSelect;

/**
 * Workflow step spans table.
 * Stores OTel-inspired telemetry for each node execution.
 */
export const workflowStepSpansDual = defineDualTable(
  'workflow_step_spans',
  (c) => ({
    /** Workflow execution this span belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Runtime frame this span represents within the execution. */
    frameId: c.text('frame_id').notNull(),
    /** Step identifier within the workflow definition. */
    stepId: c.text('step_id').notNull(),
    /** Step type discriminant. */
    stepType: c.text('step_type').notNull(),
    /** Current span status. */
    status: c.text('status').$type<SpanStatus>().notNull(),
    /** Step start timestamp (epoch ms). */
    startedAt: c.epochMs('started_at'),
    /** Step completion timestamp (epoch ms). */
    completedAt: c.epochMs('completed_at'),
    /** Wall-clock duration in milliseconds. */
    durationMs: c.int4('duration_ms'),
    /** Input tokens consumed (agent steps). */
    inputTokens: c.int4('input_tokens'),
    /** Output tokens produced (agent steps). */
    outputTokens: c.int4('output_tokens'),
    /** Estimated cost in USD (agent steps). */
    estimatedCost: c.float8('estimated_cost'),
    /** Number of tool calls (agent steps). */
    toolCallCount: c.int4('tool_call_count'),
    /** Serialized step input (JSON string). */
    input: c.text('input'),
    /** Serialized step output (JSON string). */
    output: c.text('output'),
  }),
  {
    sqlite: (t) => [
      primaryKey({ columns: [t.executionId, t.frameId] }),
      index('idx_workflow_step_spans_status').on(t.status),
    ],
    postgres: (t) => [
      pgPrimaryKey({ columns: [t.executionId, t.frameId] }),
      pgIndex('idx_workflow_step_spans_status').on(t.status),
    ],
  },
);

/** SQLite face of the `workflow_step_spans` table (canonical schema). */
export const workflowStepSpans = workflowStepSpansDual.sqlite;

export type InsertWorkflowStepSpan = typeof workflowStepSpans.$inferInsert;
export type SelectWorkflowStepSpan = typeof workflowStepSpans.$inferSelect;

/**
 * Workflow execution links table.
 * Stores cross-execution references for pipeline tracing.
 */
export const workflowExecutionLinksDual = defineDualTable(
  'workflow_execution_links',
  (c) => ({
    /** Execution that caused the link. */
    sourceExecutionId: c
      .text('source_execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Execution that was created as a result. */
    targetExecutionId: c
      .text('target_execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Relationship type. */
    linkType: c.text('link_type').$type<ExecutionLinkType>().notNull(),
    /** Optional metadata (e.g., reason, target station). */
    metadata: c.jsonCol<Record<string, unknown>>('metadata'),
  }),
  {
    sqlite: (t) => [
      primaryKey({ columns: [t.sourceExecutionId, t.targetExecutionId] }),
      index('idx_workflow_execution_links_target').on(t.targetExecutionId),
    ],
    postgres: (t) => [
      pgPrimaryKey({ columns: [t.sourceExecutionId, t.targetExecutionId] }),
      pgIndex('idx_workflow_execution_links_target').on(t.targetExecutionId),
    ],
  },
);

/** SQLite face of the `workflow_execution_links` table (canonical schema). */
export const workflowExecutionLinks = workflowExecutionLinksDual.sqlite;

export type InsertWorkflowExecutionLink = typeof workflowExecutionLinks.$inferInsert;
export type SelectWorkflowExecutionLink = typeof workflowExecutionLinks.$inferSelect;

/**
 * Workflow run-context snapshots table.
 *
 * Stores a complete, immutable snapshot of the configuration needed to run a
 * workflow execution. Keyed by `executionId` (1:1 with `workflow_executions`).
 *
 * The `source.kind` discriminant is stored flat (`sourceKind` + optional
 * `sourcePath`/`sourceFilename`/`sourceCode`) for efficient querying.
 * Large blobs (`definitionSnapshot`, `workerManifest`, `context`, `env`, etc.)
 * are stored as JSON columns.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowRunContextsDual = defineDualTable(
  'workflow_run_contexts',
  (c) => ({
    /** Unique execution identifier (1:1 with workflow_executions.id). */
    executionId: c
      .text('execution_id')
      .primaryKey()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Workflow definition identifier. */
    workflowId: c.text('workflow_id').notNull(),
    /** Coordinator session that owns this execution. */
    coordinatorSessionId: c.text('coordinator_session_id').notNull(),
    /** Workflow source kind discriminant (`path`, `source`, `definition`). */
    sourceKind: c.text('source_kind').notNull(),
    /** Absolute file path (for `kind === 'path'`). */
    sourcePath: c.text('source_path'),
    /** Virtual filename (for `kind === 'source'`). */
    sourceFilename: c.text('source_filename'),
    /** Inline source code (for `kind === 'source'`). */
    sourceCode: c.text('source_code'),
    /** Serialized definition snapshot (JSON). Present for `kind === 'definition'`. */
    definitionSnapshot: c.jsonCol<WorkflowDefinition>('definition_snapshot'),
    /** Resolved worker contribution manifest (JSON). */
    workerManifest: c.jsonCol<WorkerContributionManifest>('worker_manifest').notNull(),
    /** Bound workflow input value (JSON). */
    inputs: c.jsonCol<JsonValue>('inputs'),
    /** Bound workflow configuration values (JSON object). */
    config: c.jsonCol<Record<string, JsonValue>>('config').notNull().default(sql`'{}'`),
    /** Trigger payload from the firing trigger (JSON object). */
    triggerPayload: c.jsonCol<Record<string, JsonValue>>('trigger_payload').notNull(),
    /** Explicit artifact reference supplied by the execution starter. */
    artifactRef: c.jsonCol<WorkflowRunContext['artifactRef']>('artifact_ref'),
    /** Advisory worker provisioning hints supplied by the start request. */
    executionHints: c.jsonCol<WorkflowRunContext['executionHints']>('execution_hints'),
    /** Opaque dispatch metadata that must survive pause/resume boundaries. */
    dispatchMetadata: c.jsonCol<WorkflowRunContext['dispatchMetadata']>('dispatch_metadata'),
    /** Scope type discriminant. */
    scopeType: c
      .textEnum('scope_type', { enum: ['global', 'workspace', 'session', 'external'] as const })
      .notNull()
      .default('global')
      .$type<WorkflowExecutionScope['type']>(),
    /** Scope kind (for `type === 'external'`; empty string otherwise). */
    scopeKind: c.text('scope_kind').notNull().default(''),
    /** Scope identifier (for `workspace`/`session`/`external`; empty string for `global`). */
    scopeId: c.text('scope_id').notNull().default(''),
    /** Bus subject for cancellation signals. */
    cancelSubject: c.text('cancel_subject').notNull(),
    /**
     * Platform/workspace context (JSON).
     * Contains `repoPath`, `makaioHome`, `os`, `arch`, and optional `worktree`.
     */
    context: c
      .jsonCol<{
        repoPath: string;
        makaioHome: string;
        os: 'darwin' | 'linux' | 'win32';
        arch: string;
        worktree?: string;
      }>('context')
      .notNull(),
    /** Extra non-secret environment variables (JSON object). */
    env: c.jsonCol<Record<string, string>>('env').notNull(),
    /** Snapshot creation timestamp (epoch ms). */
    createdAt: c.epochMs('created_at').notNull(),
    /**
     * Durable record of the suspension strategy selected for this execution.
     *
     * Persisted so resumers and redispatchers can apply the same strategy
     * without re-resolving provider capabilities. Null for rows created before
     * this column was introduced — callers should fall back to `'wait-in-process'`.
     */
    suspensionStrategy: c.text('suspension_strategy').$type<WorkflowRunContext['suspensionStrategy']>(),
  }),
  {
    sqlite: (t) => [index('idx_run_contexts_workflow').on(t.workflowId)],
    postgres: (t) => [pgIndex('idx_run_contexts_workflow').on(t.workflowId)],
  },
);

/** SQLite face of the `workflow_run_contexts` table (canonical schema). */
export const workflowRunContexts = workflowRunContextsDual.sqlite;

export type InsertWorkflowRunContext = typeof workflowRunContexts.$inferInsert;
export type SelectWorkflowRunContext = typeof workflowRunContexts.$inferSelect;

// ─────────────────────────────────────────────────────────────
// WorkLog Projection Tables
//
// These tables are write-side projections driven by bus events.
// They must NOT be required for the runtime to make progress —
// if writes fail, execution continues unaffected.
// ─────────────────────────────────────────────────────────────

/**
 * WorkLog execution summaries table.
 *
 * One row per workflow execution. Updated in place as execution lifecycle
 * events arrive. Suitable for list views, dashboards, and status polling.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const worklogSummariesDual = defineDualTable(
  'worklog_summaries',
  (c) => ({
    /** Unique execution identifier (1:1 with workflow_executions.id). */
    executionId: c
      .text('execution_id')
      .primaryKey()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Workflow definition identifier. */
    workflowId: c.text('workflow_id').notNull(),
    /** Human-readable workflow name at execution start. */
    workflowName: c.text('workflow_name'),
    /**
     * Current execution status. Kept in sync via event projection.
     */
    status: c
      .textEnum('status', { enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const })
      .notNull(),
    /** Epoch milliseconds when the execution started. */
    startedAt: c.epochMs('started_at').notNull(),
    /** Epoch milliseconds when the execution reached a terminal status. */
    completedAt: c.epochMs('completed_at'),
    /** Wall-clock duration in milliseconds. Present once execution completes. */
    durationMs: c.int4('duration_ms'),
    /** Aggregated input tokens across all station frames. */
    totalInputTokens: c.int4('total_input_tokens'),
    /** Aggregated output tokens across all station frames. */
    totalOutputTokens: c.int4('total_output_tokens'),
    /** Aggregated estimated cost in USD across all station frames. */
    totalEstimatedCost: c.float8('total_estimated_cost'),
    /** Human-readable error message when `status` is `'failed'`. */
    error: c.text('error'),
    /** Identifier of the node that caused failure. */
    failedNodeId: c.text('failed_node_id'),
  }),
  {
    sqlite: (t) => [
      // Index on workflowId + startedAt for per-workflow listing with ordering.
      index('idx_worklog_summaries_workflow_started').on(t.workflowId, t.startedAt),
      // Index on status for dashboard filtering.
      index('idx_worklog_summaries_status').on(t.status),
    ],
    postgres: (t) => [
      pgIndex('idx_worklog_summaries_workflow_started').on(t.workflowId, t.startedAt),
      pgIndex('idx_worklog_summaries_status').on(t.status),
    ],
  },
);

/** SQLite face of the `worklog_summaries` table (canonical schema). */
export const worklogSummaries = worklogSummariesDual.sqlite;

export type InsertWorklogSummary = typeof worklogSummaries.$inferInsert;
export type SelectWorklogSummary = typeof worklogSummaries.$inferSelect;

/**
 * WorkLog frame entries table.
 *
 * One row per frame execution. Updated as frame lifecycle events arrive.
 * Multiple rows may exist per `nodeId` for iterate/iterate-chain expansions.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const worklogFrameEntriesDual = defineDualTable(
  'worklog_frame_entries',
  (c) => ({
    /** Unique frame identifier within the execution. */
    frameId: c.text('frame_id').primaryKey(),
    /** Execution this frame belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Node identifier from the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Node type discriminant. */
    nodeType: c.text('node_type').notNull().$type<WorkflowNodeType>(),
    /**
     * Ordered path of frame IDs from the root frame to this frame (inclusive).
     * Stored as a JSON array for tree correlation.
     */
    path: c.jsonCol<string[]>('path').notNull(),
    /** Current or terminal frame status. */
    status: c
      .textEnum('status', {
        enum: ['pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled'] as const,
      })
      .notNull(),
    /** Zero-based attempt index. 0 for first attempt, incremented on retry. */
    attempt: c.int4('attempt').notNull().default(0),
    /** Zero-based iteration index for frames inside an iterate node. */
    iteration: c.int4('iteration'),
    /** Branch key for frames inside a parallel node. */
    branchKey: c.text('branch_key'),
    /** Epoch milliseconds when the frame started executing. */
    startedAt: c.epochMs('started_at'),
    /** Epoch milliseconds when the frame reached a terminal status. */
    completedAt: c.epochMs('completed_at'),
    /** Wall-clock duration in milliseconds. */
    durationMs: c.int4('duration_ms'),
    /** Input tokens consumed (station frames with LLM execution). */
    inputTokens: c.int4('input_tokens'),
    /** Output tokens produced (station frames with LLM execution). */
    outputTokens: c.int4('output_tokens'),
    /** Estimated cost in USD (station frames with LLM execution). */
    estimatedCost: c.float8('estimated_cost'),
    /** Human-readable error message when `status` is `'failed'`. */
    error: c.text('error'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution frame lookup.
      index('idx_worklog_frame_entries_execution').on(t.executionId),
    ],
    postgres: (t) => [pgIndex('idx_worklog_frame_entries_execution').on(t.executionId)],
  },
);

/** SQLite face of the `worklog_frame_entries` table (canonical schema). */
export const worklogFrameEntries = worklogFrameEntriesDual.sqlite;

export type InsertWorklogFrameEntry = typeof worklogFrameEntries.$inferInsert;
export type SelectWorklogFrameEntry = typeof worklogFrameEntries.$inferSelect;

/**
 * WorkLog artifact write events table.
 *
 * One row per artifact write produced by a workflow execution frame.
 * Enables "show me all artifacts produced by this execution" queries.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const worklogArtifactWritesDual = defineDualTable(
  'worklog_artifact_writes',
  (c) => ({
    /** Auto-generated surrogate key (executionId:frameId:artifactKind:artifactId). */
    id: c.text('id').primaryKey(),
    /** Execution that triggered the artifact write. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Frame that produced the artifact write. */
    frameId: c.text('frame_id').notNull(),
    /** Node identifier that declared the write. */
    nodeId: c.text('node_id').notNull(),
    /**
     * Artifact binding (kind, schemaVersion, scope) as a JSON object.
     * Describes what the artifact is, not its content.
     */
    artifact: c.jsonCol<WorkflowArtifactBinding>('artifact').notNull(),
    /**
     * Artifact revision identifier assigned by the artifact service on write.
     * Absent if the write is still in-flight or failed.
     */
    revision: c.text('revision'),
    /** Epoch milliseconds when the write was recorded. */
    writtenAt: c.epochMs('written_at').notNull(),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution artifact write lookup.
      index('idx_worklog_artifact_writes_execution').on(t.executionId),
    ],
    postgres: (t) => [pgIndex('idx_worklog_artifact_writes_execution').on(t.executionId)],
  },
);

/** SQLite face of the `worklog_artifact_writes` table (canonical schema). */
export const worklogArtifactWrites = worklogArtifactWritesDual.sqlite;

export type InsertWorklogArtifactWrite = typeof worklogArtifactWrites.$inferInsert;
export type SelectWorklogArtifactWrite = typeof worklogArtifactWrites.$inferSelect;

/**
 * WorkLog gate events table.
 *
 * One row per gate state transition. Enables "show me all pending gates
 * across executions" queries without scanning the full frame state.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const worklogGateEventsDual = defineDualTable(
  'worklog_gate_events',
  (c) => ({
    /** Auto-generated surrogate key (executionId:nodeId:frameId). */
    id: c.text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Node identifier of the gate in the workflow definition. */
    nodeId: c.text('node_id').notNull(),
    /** Frame identifier for the gate's execution frame. */
    frameId: c.text('frame_id').notNull(),
    /**
     * Latest gate status. Updated on each gate state transition event.
     * Mirrors `WorkLogGateEvent.status`.
     */
    status: c
      .textEnum('status', { enum: ['waiting', 'resumed', 'rejected', 'timed-out', 'cancelled'] as const })
      .notNull()
      .$type<WorkLogGateEvent['status']>(),
    /**
     * Prompt shown to the reviewer, after template interpolation.
     * Populated when the gate entered `waiting` status.
     */
    prompt: c.text('prompt'),
    /** Epoch milliseconds when the gate entered `waiting`. */
    openedAt: c.epochMs('opened_at').notNull(),
    /** Epoch milliseconds when the gate left `waiting`. */
    resolvedAt: c.epochMs('resolved_at'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: c.jsonCol<JsonValue>('resume_data'),
  }),
  {
    sqlite: (t) => [
      // Efficient per-execution gate lookup.
      index('idx_worklog_gate_events_execution').on(t.executionId),
      // Index on status for "pending gates" queries.
      index('idx_worklog_gate_events_status').on(t.status),
    ],
    postgres: (t) => [
      pgIndex('idx_worklog_gate_events_execution').on(t.executionId),
      pgIndex('idx_worklog_gate_events_status').on(t.status),
    ],
  },
);

/** SQLite face of the `worklog_gate_events` table (canonical schema). */
export const worklogGateEvents = worklogGateEventsDual.sqlite;

export type InsertWorklogGateEvent = typeof worklogGateEvents.$inferInsert;
export type SelectWorklogGateEvent = typeof worklogGateEvents.$inferSelect;

// ─────────────────────────────────────────────────────────────
// Workflow Execution State Tables
//
// Current-state snapshot and append-only mutation log for
// typed per-execution state managed via the step-context API.
// ─────────────────────────────────────────────────────────────

/**
 * Workflow execution state snapshot table.
 *
 * Stores the latest state value for each execution. Updated in place via
 * optimistic-concurrency patches through the `patchWorkflowState` handler.
 * The `sequence` column is a monotonically increasing counter used for
 * compare-and-set conflict detection.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowExecutionStateDual = defineDualTable('workflow_execution_state', (c) => ({
  /** Execution this state belongs to (1:1 with workflow_executions.id). */
  executionId: c
    .text('execution_id')
    .primaryKey()
    .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
  /** Monotonically increasing sequence number for optimistic concurrency. */
  sequence: c.int4('sequence').notNull().default(0),
  /** Current state value (JSON). */
  value: c.jsonCol<JsonValue>('value').notNull(),
  /** Last update timestamp (epoch ms). */
  updatedAt: c.epochMs('updated_at').notNull(),
}));

/** SQLite face of the `workflow_execution_state` table (canonical schema). */
export const workflowExecutionState = workflowExecutionStateDual.sqlite;

export type InsertWorkflowExecutionState = typeof workflowExecutionState.$inferInsert;
export type SelectWorkflowExecutionState = typeof workflowExecutionState.$inferSelect;

/**
 * Workflow execution state mutation log table.
 *
 * Append-only log of every state mutation applied to an execution. Each row
 * records the JSON-Patch array (`patch`) and the resulting full value
 * (`value`) at the given `sequence` number. Used for audit trails,
 * debugging, and eventual replay.
 *
 * CENTRAL tier — migrated alongside `workflow_executions`.
 */
export const workflowExecutionStateEventsDual = defineDualTable(
  'workflow_execution_state_events',
  (c) => ({
    /** Execution this event belongs to. */
    executionId: c
      .text('execution_id')
      .notNull()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    /** Sequence number of the mutation (matches the snapshot sequence after apply). */
    sequence: c.int4('sequence').notNull(),
    /** JSON-Patch operations applied in this mutation (JSON array). */
    patch: c.jsonCol<JsonPatchOperation[]>('patch').notNull(),
    /** Full state value after applying the patch (JSON). */
    value: c.jsonCol<JsonValue>('value').notNull(),
    /** Mutation timestamp (epoch ms). */
    createdAt: c.epochMs('created_at').notNull(),
  }),
  {
    sqlite: (t) => [primaryKey({ columns: [t.executionId, t.sequence] })],
    postgres: (t) => [pgPrimaryKey({ columns: [t.executionId, t.sequence] })],
  },
);

/** SQLite face of the `workflow_execution_state_events` table (canonical schema). */
export const workflowExecutionStateEvents = workflowExecutionStateEventsDual.sqlite;

export type InsertWorkflowExecutionStateEvent = typeof workflowExecutionStateEvents.$inferInsert;
export type SelectWorkflowExecutionStateEvent = typeof workflowExecutionStateEvents.$inferSelect;
