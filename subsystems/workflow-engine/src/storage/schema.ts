import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index, primaryKey, real } from 'drizzle-orm/sqlite-core';
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
} from '@makaio/contracts';

/**
 * Scope columns shared by `workflowDefinitions` and `workflowExecutions`.
 * @returns Column definitions for `scopeType`, `scopeKind`, and `scopeId`
 */
function scopeColumns() {
  return {
    scopeType: text('scope_type', {
      enum: ['global', 'workspace', 'session', 'external'],
    })
      .notNull()
      .$type<WorkflowExecutionScope['type']>(),
    scopeKind: text('scope_kind').notNull().default(''),
    scopeId: text('scope_id').notNull().default(''),
  } as const;
}

/**
 * Workflow definitions table.
 * Stores pipeline-primitive workflow definitions with a `root` sequence node tree.
 */
export const workflowDefinitions = sqliteTable(
  'workflow_definitions',
  {
    /** Unique workflow identifier. */
    id: text('id').primaryKey(),
    /** Workflow name. */
    name: text('name').notNull(),
    /** Human-readable description. */
    description: text('description'),
    /**
     * Root sequence node tree (JSON).
     * Replaces the old flat `steps` DAG with a structured `WorkflowSequenceNode` tree.
     */
    root: text('root', { mode: 'json' }).$type<WorkflowDefinition['root']>().notNull(),
    /** JSON Schema for workflow input parameters (JSON object). */
    inputSchema: text('input_schema', { mode: 'json' }).$type<Record<string, JsonValue>>(),
    /** JSON Schema for static workflow configuration (JSON object). */
    configSchema: text('config_schema', { mode: 'json' }).$type<Record<string, JsonValue>>(),
    /** JSON Schema for the workflow's primary output (JSON object). */
    outputSchema: text('output_schema', { mode: 'json' }).$type<Record<string, JsonValue>>(),
    /** Primary artifact binding for workflow output/state (JSON object). */
    artifact: text('artifact', { mode: 'json' }).$type<WorkflowDefinition['artifact']>(),
    /** Trigger configuration (JSON array). Null means manual-only default. */
    triggers: text('triggers', { mode: 'json' }).$type<WorkflowTrigger[]>(),
    ...scopeColumns(),
    /** Creation timestamp. */
    createdAt: integer('created_at').notNull(),
    /** Last update timestamp. */
    updatedAt: integer('updated_at').notNull(),
    /** Canvas layout hints for the visual editor (JSON object). */
    canvasLayout: text('canvas_layout', { mode: 'json' }).$type<Record<string, JsonValue>>(),
    /**
     * Provenance record for extension-synced definitions (JSON).
     * Absent on locally-authored definitions.
     */
    source: text('source', { mode: 'json' }).$type<WorkflowDefinitionProvenance>(),
    /**
     * Advisory execution hints for worker provisioning (JSON).
     * Merged with per-call hints at execution start.
     */
    executionHints: text('execution_hints', { mode: 'json' }).$type<ExecutionHints>(),
  },
  (table) => [
    // (name, scopeType, scopeKind, scopeId) unique to prevent duplicate names per scope.
    uniqueIndex('uniq_workflow_definitions_name_scope').on(table.name, table.scopeType, table.scopeKind, table.scopeId),
    // Index on scope columns for efficient filtering.
    index('idx_workflow_definitions_scope').on(table.scopeType, table.scopeKind, table.scopeId),
  ],
);

/**
 * Workflow executions table.
 * Stores runtime state of workflow executions.
 */
export const workflowExecutions = sqliteTable(
  'workflow_executions',
  {
    /** Unique execution identifier. */
    id: text('id').primaryKey(),
    /** Workflow definition or ephemeral source execution identifier. */
    workflowId: text('workflow_id').notNull(),
    /** Coordinator session ID for this execution. */
    coordinatorSessionId: text('coordinator_session_id'),
    /** Current execution status. */
    status: text('status', {
      enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    /** Bound workflow input value (JSON). */
    inputs: text('inputs', { mode: 'json' }).$type<JsonValue>(),
    /** Error message if execution failed. */
    error: text('error'),
    /** Execution start timestamp. */
    startedAt: integer('started_at').notNull(),
    /** Execution completion timestamp. */
    completedAt: integer('completed_at'),
    /** Trigger payload from the firing trigger (JSON object). */
    triggerPayload: text('trigger_payload', { mode: 'json' }).$type<Record<string, JsonValue>>(),
    ...scopeColumns(),
  },
  (table) => [
    // Index on status for efficient filtering.
    index('idx_workflow_executions_status').on(table.status),
    // Index on scope columns + startedAt for bounded scope listing with ordering.
    index('idx_workflow_executions_scope_started').on(table.scopeType, table.scopeKind, table.scopeId, table.startedAt),
    // Index on workflowId + startedAt for per-workflow listing with ordering.
    index('idx_workflow_executions_workflow_started').on(table.workflowId, table.startedAt),
  ],
);

export type InsertWorkflowDefinition = typeof workflowDefinitions.$inferInsert;
export type SelectWorkflowDefinition = typeof workflowDefinitions.$inferSelect;
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
export const workflowExecutionFrames = sqliteTable(
  'workflow_execution_frames',
  {
    /** Unique frame identifier within the execution. */
    frameId: text('frame_id').primaryKey(),
    /** Execution this frame belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Node identifier from the workflow definition. */
    nodeId: text('node_id').notNull(),
    /** Node type discriminant for routing and display. */
    nodeType: text('node_type').notNull().$type<WorkflowFrameState['nodeType']>(),
    /**
     * Ordered path of frame IDs from the root frame to this frame (inclusive).
     * Used for tree traversal, log correlation, and UI breadcrumb display.
     */
    path: text('path', { mode: 'json' }).$type<string[]>().notNull(),
    /** Parent frame ID. Absent for the root frame. */
    parentFrameId: text('parent_frame_id'),
    /** Current frame execution status. */
    status: text('status').notNull().default('pending').$type<WorkflowFrameState['status']>(),
    /**
     * Number of execution attempts for this frame (zero-based).
     * Incremented each time the frame is retried after failure.
     */
    attempt: integer('attempt').notNull().default(0),
    /**
     * Zero-based iteration index when this frame belongs to an `iterate` or
     * `iterate-chain` expansion. Absent for non-iteration frames.
     */
    iteration: integer('iteration'),
    /**
     * Branch key when this frame is a child of a `parallel` node.
     * Matches a key in `WorkflowParallelNode.branches`.
     */
    branchKey: text('branch_key'),
    /** JSON-serializable output produced by the node on completion. */
    output: text('output', { mode: 'json' }).$type<JsonValue>(),
    /** Whether `output` was explicitly produced, including JSON null. */
    outputPresent: integer('output_present', { mode: 'boolean' }).notNull().default(false),
    /** Human-readable error message when status is `failed`. */
    error: text('error'),
    /** Epoch milliseconds when the frame started executing. */
    startedAt: integer('started_at'),
    /** Epoch milliseconds when the frame reached a terminal status. */
    completedAt: integer('completed_at'),
  },
  (table) => [
    // Efficient per-execution frame lookup.
    index('idx_workflow_execution_frames_execution').on(table.executionId),
    // Parent-frame traversal.
    index('idx_workflow_execution_frames_parent').on(table.parentFrameId),
  ],
);

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
export const workflowGateInstances = sqliteTable(
  'workflow_gate_instances',
  {
    /** Unique gate instance identifier. */
    id: text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Node ID of the gate in the workflow definition. */
    nodeId: text('node_id').notNull(),
    /** Frame ID of the gate's execution frame. */
    frameId: text('frame_id').notNull(),
    /**
     * JSON Schema describing the expected resume data payload.
     * Callers must satisfy this schema when responding to the gate.
     */
    schema: text('schema', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /**
     * Optional prompt shown to the reviewer after template interpolation.
     * Populated from the gate node's `prompt` field at execution time.
     */
    prompt: text('prompt'),
    /** Current gate status. */
    status: text('status').notNull().default('waiting').$type<WorkflowGateInstance['status']>(),
    /** Effective timeout action captured when the gate opened. */
    autoAction: text('auto_action', { enum: ['approve', 'reject'] })
      .notNull()
      .default('reject'),
    /** Effective timeout in milliseconds captured when the gate opened. */
    timeoutMs: integer('timeout_ms'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: text('resume_data', { mode: 'json' }).$type<JsonValue>(),
    /** Whether `resume_data` was explicitly submitted, including JSON null. */
    resumeDataPresent: integer('resume_data_present', { mode: 'boolean' }).notNull().default(false),
    /** Epoch milliseconds when the gate was created (node entered). */
    createdAt: integer('created_at').notNull(),
    /** Epoch milliseconds when the gate left the `waiting` status. */
    resolvedAt: integer('resolved_at'),
  },
  (table) => [
    // Efficient per-execution gate lookup.
    index('idx_workflow_gate_instances_execution').on(table.executionId),
    // Frame-based gate lookup for iterate-expanded gates.
    index('idx_workflow_gate_instances_frame').on(table.frameId),
  ],
);

export type InsertWorkflowGateInstance = typeof workflowGateInstances.$inferInsert;
export type SelectWorkflowGateInstance = typeof workflowGateInstances.$inferSelect;

/**
 * Workflow step spans table.
 * Stores OTel-inspired telemetry for each node execution.
 */
export const workflowStepSpans = sqliteTable(
  'workflow_step_spans',
  {
    /** Workflow execution this span belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Runtime frame this span represents within the execution. */
    frameId: text('frame_id').notNull(),
    /** Step identifier within the workflow definition. */
    stepId: text('step_id').notNull(),
    /** Step type discriminant. */
    stepType: text('step_type').notNull(),
    /** Current span status. */
    status: text('status').$type<SpanStatus>().notNull(),
    /** Step start timestamp (epoch ms). */
    startedAt: integer('started_at'),
    /** Step completion timestamp (epoch ms). */
    completedAt: integer('completed_at'),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms'),
    /** Input tokens consumed (agent steps). */
    inputTokens: integer('input_tokens'),
    /** Output tokens produced (agent steps). */
    outputTokens: integer('output_tokens'),
    /** Estimated cost in USD (agent steps). */
    estimatedCost: real('estimated_cost'),
    /** Number of tool calls (agent steps). */
    toolCallCount: integer('tool_call_count'),
    /** Serialized step input (JSON string). */
    input: text('input'),
    /** Serialized step output (JSON string). */
    output: text('output'),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.frameId] }),
    index('idx_workflow_step_spans_status').on(table.status),
  ],
);

/**
 * Workflow execution links table.
 * Stores cross-execution references for pipeline tracing.
 */
export const workflowExecutionLinks = sqliteTable(
  'workflow_execution_links',
  {
    /** Execution that caused the link. */
    sourceExecutionId: text('source_execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Execution that was created as a result. */
    targetExecutionId: text('target_execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Relationship type. */
    linkType: text('link_type').$type<ExecutionLinkType>().notNull(),
    /** Optional metadata (e.g., reason, target station). */
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceExecutionId, table.targetExecutionId] }),
    index('idx_workflow_execution_links_target').on(table.targetExecutionId),
  ],
);

export type InsertWorkflowStepSpan = typeof workflowStepSpans.$inferInsert;
export type SelectWorkflowStepSpan = typeof workflowStepSpans.$inferSelect;
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
export const workflowRunContexts = sqliteTable(
  'workflow_run_contexts',
  {
    /** Unique execution identifier (1:1 with workflow_executions.id). */
    executionId: text('execution_id').primaryKey(),
    /** Workflow definition identifier. */
    workflowId: text('workflow_id').notNull(),
    /** Coordinator session that owns this execution. */
    coordinatorSessionId: text('coordinator_session_id').notNull(),
    /** Workflow source kind discriminant (`path`, `source`, `definition`). */
    sourceKind: text('source_kind').notNull(),
    /** Absolute file path (for `kind === 'path'`). */
    sourcePath: text('source_path'),
    /** Virtual filename (for `kind === 'source'`). */
    sourceFilename: text('source_filename'),
    /** Inline source code (for `kind === 'source'`). */
    sourceCode: text('source_code'),
    /** Serialized definition snapshot (JSON). Present for `kind === 'definition'`. */
    definitionSnapshot: text('definition_snapshot', { mode: 'json' }).$type<WorkflowDefinition>(),
    /** Resolved worker contribution manifest (JSON). */
    workerManifest: text('worker_manifest', { mode: 'json' }).$type<WorkerContributionManifest>().notNull(),
    /** Bound workflow input value (JSON). */
    inputs: text('inputs', { mode: 'json' }).$type<JsonValue>(),
    /** Bound workflow configuration values (JSON object). */
    config: text('config', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull().default(sql`'{}'`),
    /** Trigger payload from the firing trigger (JSON object). */
    triggerPayload: text('trigger_payload', { mode: 'json' }).$type<Record<string, JsonValue>>().notNull(),
    /** Explicit artifact reference supplied by the execution starter. */
    artifactRef: text('artifact_ref', { mode: 'json' }).$type<WorkflowRunContext['artifactRef']>(),
    /** Advisory worker provisioning hints supplied by the start request. */
    executionHints: text('execution_hints', { mode: 'json' }).$type<WorkflowRunContext['executionHints']>(),
    /** Opaque dispatch metadata that must survive pause/resume boundaries. */
    dispatchMetadata: text('dispatch_metadata', { mode: 'json' }).$type<WorkflowRunContext['dispatchMetadata']>(),
    /** Scope type discriminant. */
    scopeType: text('scope_type', {
      enum: ['global', 'workspace', 'session', 'external'],
    })
      .notNull()
      .default('global')
      .$type<WorkflowExecutionScope['type']>(),
    /** Scope kind (for `type === 'external'`; empty string otherwise). */
    scopeKind: text('scope_kind').notNull().default(''),
    /** Scope identifier (for `workspace`/`session`/`external`; empty string for `global`). */
    scopeId: text('scope_id').notNull().default(''),
    /** Bus subject for cancellation signals. */
    cancelSubject: text('cancel_subject').notNull(),
    /**
     * Platform/workspace context (JSON).
     * Contains `repoPath`, `makaioHome`, `os`, `arch`, and optional `worktree`.
     */
    context: text('context', { mode: 'json' })
      .$type<{
        repoPath: string;
        makaioHome: string;
        os: 'darwin' | 'linux' | 'win32';
        arch: string;
        worktree?: string;
      }>()
      .notNull(),
    /** Extra non-secret environment variables (JSON object). */
    env: text('env', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    /** Snapshot creation timestamp (epoch ms). */
    createdAt: integer('created_at').notNull(),
    /**
     * Durable record of the suspension strategy selected for this execution.
     *
     * Persisted so resumers and redispatchers can apply the same strategy
     * without re-resolving provider capabilities. Null for rows created before
     * this column was introduced — callers should fall back to `'wait-in-process'`.
     */
    suspensionStrategy: text('suspension_strategy').$type<WorkflowRunContext['suspensionStrategy']>(),
  },
  (table) => [index('idx_run_contexts_workflow').on(table.workflowId)],
);

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
export const worklogSummaries = sqliteTable(
  'worklog_summaries',
  {
    /** Unique execution identifier (1:1 with workflow_executions.id). */
    executionId: text('execution_id').primaryKey(),
    /** Workflow definition identifier. */
    workflowId: text('workflow_id').notNull(),
    /** Human-readable workflow name at execution start. */
    workflowName: text('workflow_name'),
    /**
     * Current execution status. Kept in sync via event projection.
     */
    status: text('status', {
      enum: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    /** Epoch milliseconds when the execution started. */
    startedAt: integer('started_at').notNull(),
    /** Epoch milliseconds when the execution reached a terminal status. */
    completedAt: integer('completed_at'),
    /** Wall-clock duration in milliseconds. Present once execution completes. */
    durationMs: integer('duration_ms'),
    /** Aggregated input tokens across all station frames. */
    totalInputTokens: integer('total_input_tokens'),
    /** Aggregated output tokens across all station frames. */
    totalOutputTokens: integer('total_output_tokens'),
    /** Aggregated estimated cost in USD across all station frames. */
    totalEstimatedCost: real('total_estimated_cost'),
    /** Human-readable error message when `status` is `'failed'`. */
    error: text('error'),
    /** Identifier of the node that caused failure. */
    failedNodeId: text('failed_node_id'),
  },
  (table) => [
    // Index on workflowId + startedAt for per-workflow listing with ordering.
    index('idx_worklog_summaries_workflow_started').on(table.workflowId, table.startedAt),
    // Index on status for dashboard filtering.
    index('idx_worklog_summaries_status').on(table.status),
  ],
);

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
export const worklogFrameEntries = sqliteTable(
  'worklog_frame_entries',
  {
    /** Unique frame identifier within the execution. */
    frameId: text('frame_id').primaryKey(),
    /** Execution this frame belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Node identifier from the workflow definition. */
    nodeId: text('node_id').notNull(),
    /** Node type discriminant. */
    nodeType: text('node_type').notNull().$type<WorkflowNodeType>(),
    /**
     * Ordered path of frame IDs from the root frame to this frame (inclusive).
     * Stored as a JSON array for tree correlation.
     */
    path: text('path', { mode: 'json' }).$type<string[]>().notNull(),
    /** Current or terminal frame status. */
    status: text('status', {
      enum: ['pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled'],
    }).notNull(),
    /** Zero-based attempt index. 0 for first attempt, incremented on retry. */
    attempt: integer('attempt').notNull().default(0),
    /** Zero-based iteration index for frames inside an iterate node. */
    iteration: integer('iteration'),
    /** Branch key for frames inside a parallel node. */
    branchKey: text('branch_key'),
    /** Epoch milliseconds when the frame started executing. */
    startedAt: integer('started_at'),
    /** Epoch milliseconds when the frame reached a terminal status. */
    completedAt: integer('completed_at'),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms'),
    /** Input tokens consumed (station frames with LLM execution). */
    inputTokens: integer('input_tokens'),
    /** Output tokens produced (station frames with LLM execution). */
    outputTokens: integer('output_tokens'),
    /** Estimated cost in USD (station frames with LLM execution). */
    estimatedCost: real('estimated_cost'),
    /** Human-readable error message when `status` is `'failed'`. */
    error: text('error'),
  },
  (table) => [
    // Efficient per-execution frame lookup.
    index('idx_worklog_frame_entries_execution').on(table.executionId),
  ],
);

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
export const worklogArtifactWrites = sqliteTable(
  'worklog_artifact_writes',
  {
    /** Auto-generated surrogate key (executionId:frameId:artifactKind:artifactId). */
    id: text('id').primaryKey(),
    /** Execution that triggered the artifact write. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Frame that produced the artifact write. */
    frameId: text('frame_id').notNull(),
    /** Node identifier that declared the write. */
    nodeId: text('node_id').notNull(),
    /**
     * Artifact binding (kind, schemaVersion, scope) as a JSON object.
     * Describes what the artifact is, not its content.
     */
    artifact: text('artifact', { mode: 'json' }).$type<WorkflowArtifactBinding>().notNull(),
    /**
     * Artifact revision identifier assigned by the artifact service on write.
     * Absent if the write is still in-flight or failed.
     */
    revision: text('revision'),
    /** Epoch milliseconds when the write was recorded. */
    writtenAt: integer('written_at').notNull(),
  },
  (table) => [
    // Efficient per-execution artifact write lookup.
    index('idx_worklog_artifact_writes_execution').on(table.executionId),
  ],
);

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
export const worklogGateEvents = sqliteTable(
  'worklog_gate_events',
  {
    /** Auto-generated surrogate key (executionId:nodeId:frameId). */
    id: text('id').primaryKey(),
    /** Execution this gate belongs to. */
    executionId: text('execution_id')
      .notNull()
      .references(() => workflowExecutions.id, { onDelete: 'cascade' }),
    /** Node identifier of the gate in the workflow definition. */
    nodeId: text('node_id').notNull(),
    /** Frame identifier for the gate's execution frame. */
    frameId: text('frame_id').notNull(),
    /**
     * Latest gate status. Updated on each gate state transition event.
     * Mirrors `WorkLogGateEvent.status`.
     */
    status: text('status', {
      enum: ['waiting', 'resumed', 'rejected', 'timed-out', 'cancelled'],
    })
      .notNull()
      .$type<WorkLogGateEvent['status']>(),
    /**
     * Prompt shown to the reviewer, after template interpolation.
     * Populated when the gate entered `waiting` status.
     */
    prompt: text('prompt'),
    /** Epoch milliseconds when the gate entered `waiting`. */
    openedAt: integer('opened_at').notNull(),
    /** Epoch milliseconds when the gate left `waiting`. */
    resolvedAt: integer('resolved_at'),
    /** JSON-serializable resume data submitted by the approver. */
    resumeData: text('resume_data', { mode: 'json' }).$type<JsonValue>(),
  },
  (table) => [
    // Efficient per-execution gate lookup.
    index('idx_worklog_gate_events_execution').on(table.executionId),
    // Index on status for "pending gates" queries.
    index('idx_worklog_gate_events_status').on(table.status),
  ],
);

export type InsertWorklogGateEvent = typeof worklogGateEvents.$inferInsert;
export type SelectWorklogGateEvent = typeof worklogGateEvents.$inferSelect;
