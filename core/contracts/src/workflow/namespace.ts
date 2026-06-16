import { z } from 'zod';
import { createBusNamespace, observability, type SchemaRecord } from '@makaio/core';
import {
  ExecutionListQuerySchema,
  ExecutionsByArtifactRefsQuerySchema,
  ExecutionStatusSchema,
  GateInstanceListQuerySchema,
  WorkflowDefinitionSchema,
  WorkflowExecutionSchema,
  WorkflowExecutionScopeSchema,
  WorkflowFrameStateSchema,
  WorkflowGateInstanceSchema,
  WorkflowListQuerySchema,
  WorkflowNodeTypeSchema,
  WorkflowResolvedAgentSchema,
  WorkflowResolvedRoleSchema,
} from './schemas.js';
import { JsonObjectContractSchema, JsonSchemaRecordSchema, JsonValueSchema } from '../shared/json-value.js';
import { ExecutionLinkListQuerySchema, ExecutionLinkSchema, SpanRecordSchema } from './span.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { WorkflowRunContextSchema } from './run-context.js';
import { WorkLogExecutionSummarySchema, WorkLogStatsSchema } from './worklog.js';
import { ExecutionHintsSchema } from './execution-hints.js';
import { JsonPatchOperationSchema } from './json-patch.js';

/**
 * Structured progress signal emitted by a station handler via `ctx.updateProgress()`.
 *
 * Progress updates are ephemeral — useful for real-time monitoring and
 * observer-specific projections and materializations, but not
 * durable WorkLog entries. For structured knowledge that should participate
 * in accountability chains, use Observations instead.
 */
export const WorkflowProgressUpdateSchema = z
  .object({
    /** Human-readable progress message. */
    message: z.string().min(1),
    /** Extended details for observers that can display them. */
    details: z.string().min(1).optional(),
    /**
     * Optional semantic kind for materialization routing.
     *
     * Observers can match on kind to decide projection behavior: a
     * `'station-started'` progress might be materialized immediately, while a
     * `'checkpoint'` might be reserved for aggregate views.
     *
     * Not a closed enum — workflow authors define their own vocabulary.
     */
    kind: z.string().min(1).optional(),
    /**
     * Structured metadata for observers that need more than message + details.
     *
     * The workflow does not know which observer consumes this. The observer
     * decides what to extract.
     */
    metadata: JsonValueSchema.optional(),
  })
  .strict();

/** Inferred type for {@link WorkflowProgressUpdateSchema}. */
export type WorkflowProgressUpdate = z.infer<typeof WorkflowProgressUpdateSchema>;

const StepLifecycleBaseSchema = z.object({
  executionId: z.string(),
  /** Node identifier within the workflow definition. */
  stepId: z.string(),
  /**
   * Observable node types emitting lifecycle events.
   * `station`, `delegate-agent`, `delegate-role`, and `gate` emit bus events.
   * Structural nodes (`sequence`, `parallel`, `iterate`, `iterate-chain`) do not.
   */
  stepType: z.enum(['station', 'delegate-agent', 'delegate-role', 'gate']),
});

const GateLifecycleBaseSchema = StepLifecycleBaseSchema.extend({
  stepType: z.literal('gate'),
});

const GateResolvedPayloadSchema = z.discriminatedUnion('source', [
  GateLifecycleBaseSchema.extend({
    /**
     * Runtime frame ID of the resolved gate instance.
     * Gate node IDs are not unique across dynamic/iterated frames.
     */
    frameId: z.string(),
    /** Approval action recorded for the user settlement. */
    action: z.enum(['approve', 'reject']),
    /** Source that produced the approval action. */
    source: z.literal('user'),
    /** Human-readable rationale supplied by the responder. */
    reason: z.string().optional(),
  }),
  GateLifecycleBaseSchema.extend({
    /**
     * Runtime frame ID of the resolved gate instance.
     * Gate node IDs are not unique across dynamic/iterated frames.
     */
    frameId: z.string(),
    /** Approval action recorded for the timeout settlement. */
    action: z.enum(['approve', 'reject']),
    /** Source that produced the approval action. */
    source: z.literal('timeout'),
  }),
  GateLifecycleBaseSchema.extend({
    /**
     * Runtime frame ID of the cancelled gate instance.
     * Gate node IDs are not unique across dynamic/iterated frames.
     */
    frameId: z.string(),
    /** Workflow cancellation settled the gate without resume data. */
    source: z.literal('cancelled'),
  }),
]);

/**
 * Payload emitted when a gate step requests human approval.
 * Extracted as a named constant so it can be reused by both the
 * `gate.requested` event schema and the `gate.awaitApproval` RPC request.
 */
const GateRequestedPayloadSchema = GateLifecycleBaseSchema.extend({
  workflowId: z.string(),
  workflowName: z.string(),
  title: z.string(),
  message: z.string(),
  autoAction: z.enum(['approve', 'reject']),
  timeoutMs: z.number().nullable(),
  openedAt: z.number(),
});

export const WorkflowSchemas = {
  getDefinition: {
    request: z.object({ id: z.string() }),
    response: z.object({ workflow: WorkflowDefinitionSchema.nullable() }),
  },
  setDefinition: {
    request: z.object({ workflow: WorkflowDefinitionSchema }),
    response: z.object({ id: z.string() }),
  },
  deleteDefinition: {
    request: z.object({ id: z.string() }),
    response: z.object({ deleted: z.boolean() }),
  },
  listDefinitions: {
    request: WorkflowListQuerySchema,
    response: z.object({ workflows: z.array(WorkflowDefinitionSchema) }),
  },
  'definition.created': WorkflowDefinitionSchema,
  'definition.updated': WorkflowDefinitionSchema,
  'definition.deleted': z.object({ id: z.string() }),

  start: {
    request: z.object({
      workflowId: z.string(),
      /**
       * Typed workflow input validated against the definition's `inputSchema`.
       * Replaces the old `inputs` (object-only) field to accept any JSON value.
       */
      input: JsonValueSchema.optional(),
      /**
       * Workflow configuration overrides applied on top of the definition's defaults.
       * Validated against `configSchema` when present.
       */
      config: JsonValueSchema.optional(),
      /**
       * Bind this execution to an existing artifact.
       * When provided the runtime associates produced outputs with this artifact ref.
       */
      artifactRef: WorkflowArtifactRefSchema.optional(),
      /**
       * Scope override for this execution.
       * When provided, supersedes the scope declared on the workflow definition.
       * When omitted, the executor uses the workflow definition's required scope.
       */
      scope: WorkflowExecutionScopeSchema.optional(),
      /**
       * Advisory hints for worker provisioning.
       * Passed opaquely to the execution host after JSON-safety validation.
       */
      executionHints: ExecutionHintsSchema.optional(),
      parentSessionId: z.string().optional(),
      triggerPayload: JsonObjectContractSchema.optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },
  rerun: {
    request: z.object({
      executionId: z.string().min(1),
      mode: z.enum(['snapshot', 'current']),
      input: JsonValueSchema.optional(),
      config: JsonValueSchema.optional(),
      artifactRef: WorkflowArtifactRefSchema.optional(),
      scope: WorkflowExecutionScopeSchema.optional(),
      executionHints: ExecutionHintsSchema.optional(),
      parentSessionId: z.string().optional(),
      triggerPayload: JsonObjectContractSchema.optional(),
      reason: z.string().min(1).optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },
  cancel: {
    request: z.object({ executionId: z.string(), reason: z.string().optional() }),
    response: z.object({ cancelled: z.boolean() }),
  },
  getExecution: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ execution: WorkflowExecutionSchema.nullable() }),
  },
  /**
   * List workflow executions by workflow ID or scope.
   *
   * At least one of `workflowId` or `scope` is required. `limit` is optional
   * for callers and defaults to 50 during request parsing.
   */
  listExecutions: {
    request: ExecutionListQuerySchema,
    response: z.object({ executions: z.array(WorkflowExecutionSchema) }),
  },
  /**
   * Batch-fetch recent executions grouped by artifact reference.
   *
   * Eliminates N+1 fan-out when a consumer needs execution history for
   * multiple artifacts (e.g. graph enrichment). Each ref is an independent
   * indexed lookup; results are keyed by canonical `"kind:id"` serialization.
   * Refs with no matching executions are omitted from the response.
   */
  listExecutionsByArtifactRefs: {
    request: ExecutionsByArtifactRefsQuerySchema,
    response: z.object({
      executionsByRef: z.record(z.string(), z.array(WorkflowExecutionSchema)),
    }),
  },
  /**
   * List persisted step spans for a workflow execution.
   *
   * This is the public read API for execution traces. Storage subjects remain
   * internal to the workflow subsystem.
   */
  listSpans: {
    request: z.object({ executionId: z.string() }),
    response: z.object({ spans: z.array(SpanRecordSchema) }),
  },
  /**
   * List persisted gate instances by execution and/or status.
   *
   * This is the public read API for pending and resolved gate state — either
   * per execution via `executionId`, or a cross-execution gate inbox via the
   * `status` filter (e.g. `'waiting'`). At least one filter is required and
   * results are always limited. Storage subjects remain internal to the
   * workflow subsystem.
   */
  listGateInstances: {
    request: GateInstanceListQuerySchema,
    response: z.object({ gates: z.array(WorkflowGateInstanceSchema) }),
  },
  /**
   * Record a directed link between two workflow executions.
   *
   * Public write API for cross-execution tracing (e.g. feedback loops,
   * trigger chains). Both executions must already exist — links are
   * foreign-keyed to `workflow_executions`. Upserts on (source, target).
   */
  setExecutionLink: {
    request: z.object({ link: ExecutionLinkSchema }),
    response: z.object({ id: z.string() }),
  },
  /**
   * List links between workflow executions.
   *
   * Public read API for pipeline-level traces. Storage subjects remain
   * internal to the workflow subsystem.
   */
  listExecutionLinks: {
    request: ExecutionLinkListQuerySchema,
    response: z.object({ links: z.array(ExecutionLinkSchema) }),
  },
  /**
   * List persisted execution frames for a workflow execution.
   *
   * This is the public read API for the runtime frame tree (per-node state,
   * tree paths, attempts, outputs). Note: `output` payloads can be large.
   * Storage subjects remain internal to the workflow subsystem.
   */
  listFrames: {
    request: z.object({ executionId: z.string().min(1) }),
    response: z.object({ frames: z.array(WorkflowFrameStateSchema) }),
  },
  listTriggerTypes: {
    request: z.object({}),
    response: z.object({
      triggerTypes: z.array(
        z.object({
          type: z.string(),
          displayName: z.string(),
          icon: z.string(),
          category: z.string(),
          description: z.string().optional(),
          configJsonSchema: JsonSchemaRecordSchema,
          outputJsonSchema: JsonSchemaRecordSchema,
          source: z.string(),
        }),
      ),
    }),
  },

  /**
   * Run a workflow from a TypeScript or JavaScript source file.
   *
   * The runtime loads the file, extracts the default-exported workflow
   * definition, registers it ephemerally (without persisting to storage),
   * and starts an execution. The response mirrors {@link WorkflowSchemas.start}
   * so callers can track the execution via the same lifecycle events.
   *
   * Intended for developer workflows and CLI-driven one-shot executions.
   */
  runFile: {
    request: z.object({
      /**
       * Absolute path to the workflow TypeScript or JavaScript source file.
       * The runtime resolves and imports this path directly.
       */
      filePath: z.string().min(1),
      /**
       * Trigger payload forwarded to the workflow execution context.
       * Use this to pass structured input when the file is triggered from a
       * CLI flag or stdin rather than a named bus trigger.
       */
      triggerPayload: JsonObjectContractSchema.optional(),
      /**
       * Scope override for the execution.
       * Defaults to `{ type: 'global' }` when omitted.
       */
      scope: WorkflowExecutionScopeSchema.optional(),
    }),
    response: z.object({ executionId: z.string() }),
  },

  /**
   * Resolve a named role to its full adapter configuration.
   * Called by the workflow executor when an agent step specifies `role`.
   */
  resolveRole: {
    request: z.object({ roleId: z.string().min(1) }),
    response: WorkflowResolvedRoleSchema,
  },

  /**
   * Resolve an explicit agent definition to its adapter configuration.
   * Called by the workflow executor when an agent step specifies `agentId`.
   */
  resolveAgent: {
    request: z.object({ agentId: z.string().min(1) }),
    response: WorkflowResolvedAgentSchema,
  },

  /**
   * Pull the persisted run-context snapshot for a workflow execution.
   *
   * Called by executors (Piscina threads, Docker containers, remote workers)
   * after authenticating on the bus. The host validates the caller's identity
   * against the requested `executionId` before returning the snapshot.
   *
   * Trust-boundary rules (enforced by the handler, not the schema):
   * - Local callers: always permitted.
   * - Direct HMAC callers: `peer.kind === 'workflow-execution' && peer.id === executionId`.
   * - Relay/E2E callers: authenticated and encrypted peer required.
   */
  getRunContext: {
    request: z.object({ executionId: z.string().min(1) }),
    response: WorkflowRunContextSchema,
  },

  'execution.started': z.object({
    executionId: z.string(),
    workflowId: z.string(),
    coordinatorSessionId: z.string().optional(),
    startedAt: z.number().nonnegative().optional(),
    /** Artifact the execution is bound to, when the starter supplied one. */
    artifactRef: WorkflowArtifactRefSchema.optional(),
  }),
  'execution.completed': z.object({
    executionId: z.string(),
    workflowId: z.string(),
    totalDuration: z.number(),
    completedAt: z.number().nonnegative().optional(),
  }),
  'execution.failed': z.object({
    executionId: z.string(),
    workflowId: z.string(),
    error: z.string(),
    failedStepId: z.string().optional(),
    completedAt: z.number().nonnegative().optional(),
  }),
  'execution.cancelled': z.object({
    executionId: z.string(),
    workflowId: z.string(),
    reason: z.string().optional(),
    completedAt: z.number().nonnegative().optional(),
  }),

  /**
   * Ephemeral progress signal emitted by a station handler via `ctx.updateProgress()`.
   *
   * Progress events are not persisted as WorkLog entries. Observers and
   * materialization providers consume them for real-time projections.
   */
  'execution.progress': z.object({
    /** Execution that emitted the progress signal. */
    executionId: z.string().min(1),
    /** Workflow definition being executed. */
    workflowId: z.string().min(1),
    /** Frame from which the progress signal was emitted. */
    frameId: z.string().min(1),
    /** Node that emitted the progress signal. */
    nodeId: z.string().min(1),
    /** The structured progress payload. */
    progress: WorkflowProgressUpdateSchema,
    /** Epoch milliseconds when the signal was emitted by the runtime. */
    emittedAt: z.number().int().nonnegative(),
  }),

  /**
   * Emitted when a workflow execution parks at a gate and the worker exits.
   *
   * Dispatched by providers using `exit-and-redispatch` or `exit-and-resume`
   * suspension strategies. In-process providers that block at the gate do not
   * emit this event.
   *
   * All scalar fields are projected as telemetry attributes (`traceAll`) so
   * that collectors can filter persisted facts by `executionId` without a
   * request/response correlation ID (events do not carry one).
   */
  'execution.paused': observability.schema(
    z.object({
      /** Execution that has paused. */
      executionId: z.string(),
      /** Workflow definition being executed. */
      workflowId: z.string(),
      /** Node ID of the gate in the workflow definition. */
      pausedAtGateId: z.string().min(1),
      /** Frame ID of the suspended gate instance. */
      pausedAtFrameId: z.string().min(1),
    }),
    { traceAll: true },
  ),

  'step.beforeStart': StepLifecycleBaseSchema,
  'step.started': StepLifecycleBaseSchema.extend({
    sessionId: z.string().optional(),
    subagentId: z.string().optional(),
  }),
  'step.completed': StepLifecycleBaseSchema.extend({
    /** JSON-serializable result produced by the step. */
    result: JsonValueSchema.optional(),
    duration: z.number(),
  }),
  'step.failed': StepLifecycleBaseSchema.extend({ error: z.string() }),
  'step.skipped': StepLifecycleBaseSchema.extend({
    reason: z.string().optional(),
    condition: z.string().optional(),
  }),

  'gate.requested': GateRequestedPayloadSchema,
  'gate.awaitApproval': {
    request: GateRequestedPayloadSchema,
    response: z.object({
      action: z.enum(['approve', 'reject']),
      source: z.enum(['user', 'timeout']),
      reason: z.string().optional(),
    }),
  },
  'gate.respond': {
    request: z.object({
      executionId: z.string(),
      /**
       * Node ID of the gate within the workflow definition.
       * Maps to `WorkflowGateNode.id` in the definition tree.
       */
      gateId: z.string(),
      /**
       * Approval action recorded for lifecycle/audit views.
       *
       * This is separate from `resumeData` so domain payloads can carry their
       * own decision fields while the workflow still resumes through the typed
       * gate output.
       */
      action: z.enum(['approve', 'reject']),
      /**
       * Specific frame for this gate response.
       * Required when the gate lives inside an `iterate` expansion
       * where multiple frames may be waiting for the same node.
       */
      frameId: z.string().optional(),
      /**
       * Typed resume data validated against the gate node's `resumeSchema`.
       * The runtime validates this value before unblocking the frame.
       */
      resumeData: JsonValueSchema,
      /** Human-readable rationale for the gate response. */
      reason: z.string().optional(),
    }),
    response: z.object({ accepted: z.boolean() }),
  },
  'gate.resolved': GateResolvedPayloadSchema,

  // ─────────────────────────────────────────────────────────────
  // Frame lifecycle events
  // ─────────────────────────────────────────────────────────────

  /**
   * Emitted by the runtime when a node's execution frame starts.
   *
   * One event per frame entry. For structural nodes (`parallel`, `iterate`)
   * this fires when the container frame starts, before child frames are created.
   */
  'frame.started': z.object({
    /** Execution this frame belongs to. */
    executionId: z.string(),
    /** Unique frame identifier within the execution. */
    frameId: z.string(),
    /** Node ID from the workflow definition. */
    nodeId: z.string(),
    /** Node type discriminant for routing and display. */
    nodeType: WorkflowNodeTypeSchema,
    /**
     * Ordered path of frame IDs from the root frame to this frame (inclusive).
     * Mirrors `WorkflowFrameState.path`.
     */
    path: z.array(z.string()),
    /** Parent frame ID. Absent for the root frame. */
    parentFrameId: z.string().optional(),
    /** Runtime-recorded frame start timestamp in Unix milliseconds. */
    startedAt: z.number().nonnegative().optional(),
  }),

  /**
   * Emitted by the runtime when a node's execution frame reaches a terminal
   * `completed` status.
   */
  'frame.completed': z.object({
    /** Execution this frame belongs to. */
    executionId: z.string(),
    /** Unique frame identifier within the execution. */
    frameId: z.string(),
    /** Node ID from the workflow definition. */
    nodeId: z.string(),
    /** JSON-serializable output produced by the node, if any. */
    output: JsonValueSchema.optional(),
    /** Wall-clock duration in milliseconds from frame start to completion. */
    duration: z.number().nonnegative().optional(),
    /** Runtime-recorded frame completion timestamp in Unix milliseconds. */
    completedAt: z.number().nonnegative().optional(),
  }),

  /**
   * Emitted by the runtime when a node's execution frame reaches a terminal
   * `failed` status.
   */
  'frame.failed': z.object({
    /** Execution this frame belongs to. */
    executionId: z.string(),
    /** Unique frame identifier within the execution. */
    frameId: z.string(),
    /** Node ID from the workflow definition. */
    nodeId: z.string(),
    /** Human-readable error message. */
    error: z.string(),
    /** Wall-clock duration in milliseconds from frame start to failure. */
    duration: z.number().nonnegative().optional(),
    /** Runtime-recorded frame failure timestamp in Unix milliseconds. */
    completedAt: z.number().nonnegative().optional(),
  }),

  /**
   * Emitted when a workflow frame becomes associated with an agent session.
   *
   * The workflow runtime emits this after the subagent runtime reports the
   * child session ID. Consumers use the link to correlate `agent.*` telemetry
   * back to the workflow frame that spawned it.
   */
  'frame.sessionLinked': z
    .object({
      /** Execution this frame belongs to. */
      executionId: z.string(),
      /** Unique frame identifier within the execution. */
      frameId: z.string(),
      /** Agent session created for this frame. */
      sessionId: z.string(),
    })
    .strict(),

  // ─────────────────────────────────────────────────────────────
  // Gate suspension / resumption events
  // ─────────────────────────────────────────────────────────────

  /**
   * Emitted when a gate node suspends execution awaiting a response.
   *
   * The `schema` field carries the JSON Schema for the expected `resumeData`,
   * serialized as an opaque record for display in approval UIs.
   */
  'gate.suspended': z.object({
    /** Execution this gate belongs to. */
    executionId: z.string(),
    /** Frame ID of the suspended gate frame. */
    frameId: z.string(),
    /** Node ID of the gate in the workflow definition. */
    nodeId: z.string(),
    /**
     * JSON Schema for the resume data payload, serialized as a record.
     * Callers must satisfy this schema when submitting a `gate.respond` request.
     */
    schema: JsonSchemaRecordSchema,
    /** Optional prompt shown to the reviewer after template interpolation. */
    prompt: z.string().optional(),
    /** Optional title shown to the reviewer. */
    title: z.string().optional(),
    /** Action taken when the gate timeout expires. */
    autoAction: z.enum(['approve', 'reject']),
    /** Timeout in milliseconds, or `null` when the gate waits indefinitely. */
    timeoutMs: z.number().nullable(),
    /** Epoch milliseconds when the gate opened. */
    openedAt: z.number(),
  }),

  /**
   * Emitted when a gate node resumes execution after receiving a valid response.
   *
   * The `resumeData` matches the gate's declared `resumeSchema`.
   */
  'gate.resumed': z.object({
    /** Execution this gate belongs to. */
    executionId: z.string(),
    /** Frame ID of the resumed gate frame. */
    frameId: z.string(),
    /** Node ID of the gate in the workflow definition. */
    nodeId: z.string(),
    /**
     * Typed resume data submitted by the approver and validated
     * against the gate's `resumeSchema` before unblocking.
     */
    resumeData: JsonValueSchema,
  }),

  // ─────────────────────────────────────────────────────────────
  // Dynamic topology event
  // ─────────────────────────────────────────────────────────────

  /**
   * Emitted when a dynamic region's factory is invoked and produces nodes.
   *
   * Enables tooling to trace which factory produced which nodes in a given
   * execution without scanning the full frame tree.
   */
  'dynamic.materialized': z.object({
    /** Execution where the dynamic region was materialized. */
    executionId: z.string(),
    /** Frame where materialization occurred. */
    frameId: z.string(),
    /** Factory identifier from the `WorkflowDynamicRegion` descriptor. */
    factoryId: z.string().min(1),
    /** Number of top-level nodes produced by the factory. */
    materializedNodes: z.number().int().nonnegative(),
  }),

  // ─────────────────────────────────────────────────────────────
  // Artifact update event
  // ─────────────────────────────────────────────────────────────

  /**
   * Emitted when a workflow frame produces an artifact update.
   *
   * Enables "show me all artifact writes produced by this execution" queries
   * without scanning the artifact store.
   */
  'artifact.updated': z.object({
    /** Execution that triggered the artifact update. */
    executionId: z.string(),
    /** Frame that produced the update. */
    frameId: z.string(),
    /**
     * Reference to the artifact that was updated.
     */
    artifactRef: z.object({
      /** Artifact kind string (e.g. `'implementation-plan'`). */
      kind: z.string().min(1),
      /** Artifact identifier within its kind. */
      id: z.string().min(1),
    }),
    /**
     * JSON Pointer paths to the artifact fields that changed.
     * Empty array indicates the full artifact was replaced.
     */
    paths: z.array(z.string()),
    /** Operation that produced the update (e.g. `'create'`, `'revise'`). */
    operation: z.string().min(1),
    /** Revision identifier assigned by the artifact service on write. */
    revision: z.string().min(1).optional(),
  }),

  // ─────────────────────────────────────────────────────────────
  // WorkLog RPC subjects
  // ─────────────────────────────────────────────────────────────

  /**
   * Retrieve the WorkLog execution summary for a single execution (RPC).
   *
   * Returns the denormalized summary record used by execution summary views.
   * The summary is updated as execution events arrive.
   */
  'worklog.get': {
    request: z.object({
      /** Execution identifier to retrieve the summary for. */
      executionId: z.string().min(1),
    }),
    response: z.object({
      /** The WorkLog execution summary, or `null` when the execution is not found. */
      summary: WorkLogExecutionSummarySchema.nullable(),
    }),
  },

  /**
   * List WorkLog execution summaries with optional filtering (RPC).
   *
   * At least one of `workflowId` or `status` is recommended to avoid
   * unbounded scans; both are optional to support broad projection queries.
   */
  'worklog.list': {
    request: z.object({
      /** Filter by workflow definition ID. */
      workflowId: z.string().min(1).optional(),
      /** Filter by execution status. */
      status: ExecutionStatusSchema.optional(),
      /** Maximum number of records to return. */
      limit: z.number().int().positive().optional(),
      /** Zero-based offset for pagination. */
      offset: z.number().int().nonnegative().optional(),
    }),
    response: z.object({
      /** Matching execution summaries ordered by `startedAt` descending. */
      items: z.array(WorkLogExecutionSummarySchema),
      /** Total number of matching records (before limit/offset). */
      total: z.number().int().nonnegative(),
    }),
  },

  /**
   * Aggregate WorkLog execution statistics over an optional time window (RPC).
   *
   * Filters apply to the execution `startedAt` timestamp; `since`/`until` are
   * inclusive epoch-millisecond bounds. All filters optional.
   */
  'worklog.stats': {
    request: z.object({
      /** Filter by workflow definition ID. */
      workflowId: z.string().min(1).optional(),
      /** Inclusive lower bound on execution startedAt (epoch ms). */
      since: z.number().int().nonnegative().optional(),
      /** Inclusive upper bound on execution startedAt (epoch ms). */
      until: z.number().int().nonnegative().optional(),
    }),
    response: z.object({
      /** Aggregated statistics for the matching executions. */
      stats: WorkLogStatsSchema,
    }),
  },

  /**
   * Emitted when a WorkLog record for an execution is created or updated.
   *
   * Subscribers can use this as a lightweight push notification to
   * invalidate cached summaries without polling.
   */
  'worklog.changed': z.object({
    /** Execution whose WorkLog record changed. */
    executionId: z.string().min(1),
  }),

  // ─────────────────────────────────────────────────────────────
  // Run state RPC subjects
  // ─────────────────────────────────────────────────────────────

  /**
   * Retrieve the current run state snapshot for a workflow execution (RPC).
   *
   * Returns the current sequence number and state value. Sequence `0` is
   * the initial state written at execution start.
   */
  'state.get': {
    request: z.object({
      /** Execution identifier to retrieve state for. */
      executionId: z.string().min(1),
    }),
    response: z.object({
      /** Execution identifier. */
      executionId: z.string().min(1),
      /** Monotonically increasing sequence number of the current snapshot. */
      sequence: z.number().int().nonnegative(),
      /** Current state value. */
      value: JsonValueSchema,
    }),
  },

  /**
   * Apply a state mutation to a workflow execution (RPC).
   *
   * The caller supplies the full next value and a JSON Patch array describing
   * the requested mutation. The engine persists a canonical patch derived from
   * the accepted state transition so the audit log and update events cannot
   * drift from the stored snapshot. The required `expectedSequence` lets the
   * handler reject the mutation if the current sequence does not match
   * (optimistic concurrency control).
   */
  'state.patch': {
    request: z.object({
      /** Execution identifier. */
      executionId: z.string().min(1),
      /** Expected current sequence for optimistic concurrency. */
      expectedSequence: z.number().int().nonnegative(),
      /** JSON Patch operations describing the requested mutation. */
      patch: z.array(JsonPatchOperationSchema),
      /** Full next state value after applying the patch. */
      nextValue: JsonValueSchema,
    }),
    response: z.object({
      /** Execution identifier. */
      executionId: z.string().min(1),
      /** New sequence number after the mutation. */
      sequence: z.number().int().positive(),
      /** Accepted state value. */
      value: JsonValueSchema,
    }),
  },

  /**
   * Emitted after a state mutation is accepted and persisted.
   *
   * Subscribers use this for real-time state change observation
   * without polling the `state.get` RPC.
   */
  'state.updated': z.object({
    /** Execution whose state changed. */
    executionId: z.string().min(1),
    /** Sequence number of the new snapshot. */
    sequence: z.number().int().positive(),
    /** JSON Patch operations that produced this state. */
    patch: z.array(JsonPatchOperationSchema),
    /** Full state value after the mutation. */
    value: JsonValueSchema,
    /** Epoch milliseconds when the mutation was applied. */
    updatedAt: z.number().int().positive(),
  }),
} satisfies SchemaRecord;

export const WorkflowNamespace = createBusNamespace('workflow', WorkflowSchemas);
export const WorkflowSubjects = WorkflowNamespace.subjects;
