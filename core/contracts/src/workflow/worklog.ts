import { z } from 'zod';
import { JsonSchemaRecordSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkflowArtifactBindingSchema } from './schemas.js';
import { WorkflowStepTypeSchema } from './step-runner.js';

// ─────────────────────────────────────────────────────────────
// WorkLog Projection
//
// WorkLog schemas are projection-friendly read models derived from execution
// events. They must not be required for the runtime to make progress.
// Their purpose is to provide queryable summaries for the UI, monitoring,
// and external integrations.
// ─────────────────────────────────────────────────────────────

/**
 * Summarised view of a workflow execution.
 *
 * Aggregates top-level execution metadata into a single denormalized record
 * suitable for list views, dashboards, and status polling. Updated as execution
 * events arrive; not required for runtime correctness.
 */
export const WorkLogExecutionSummarySchema = z.object({
  /** Unique execution identifier. */
  executionId: z.string().min(1),
  /** Workflow definition identifier. */
  workflowId: z.string().min(1),
  /** Human-readable workflow name at the time the execution started. */
  workflowName: z.string().optional(),
  /**
   * Current execution status.
   * Mirrors `WorkflowExecution.status` — kept in sync via event projection.
   */
  status: z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  /** Epoch milliseconds when the execution started. */
  startedAt: z.number(),
  /** Epoch milliseconds when the execution reached a terminal status. */
  completedAt: z.number().optional(),
  /** Wall-clock duration in milliseconds. Present once the execution completes. */
  durationMs: z.number().nonnegative().optional(),
  /** Aggregated token usage across all station frames. */
  totalInputTokens: z.number().int().nonnegative().optional(),
  /** Aggregated output tokens across all station frames. */
  totalOutputTokens: z.number().int().nonnegative().optional(),
  /** Aggregated estimated cost in USD across all station frames. */
  totalEstimatedCost: z.number().nonnegative().optional(),
  /** Human-readable error message when `status` is `'failed'`. */
  error: z.string().optional(),
  /** Identifier of the node that caused failure. */
  failedNodeId: z.string().optional(),
});

export type WorkLogExecutionSummary = z.infer<typeof WorkLogExecutionSummarySchema>;

// ─────────────────────────────────────────────────────────────
// Frame Entry
// ─────────────────────────────────────────────────────────────

/**
 * A single frame execution entry in the WorkLog.
 *
 * One entry per node execution frame. Captures the lifecycle of a single
 * node invocation for audit, debugging, and performance analysis.
 * Multiple entries may exist per `nodeId` if the node is retried or
 * executed inside an `iterate`/`iterate-chain` expansion.
 */
export const WorkLogFrameEntrySchema = z.object({
  /** Execution this frame belongs to. */
  executionId: z.string().min(1),
  /** Unique frame identifier within the execution. */
  frameId: z.string().min(1),
  /** Node identifier from the workflow definition. */
  nodeId: z.string().min(1),
  /** Node type discriminant — determines which telemetry fields are populated. */
  nodeType: WorkflowStepTypeSchema,
  /**
   * Ordered path of frame IDs from the root frame to this frame (inclusive).
   * Mirrors `WorkflowFrameState.path` for tree correlation without querying
   * the full frame state record.
   */
  path: z.array(z.string()),
  /** Current or terminal frame status. */
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled']),
  /** Zero-based attempt index. 0 for first attempt, incremented on retry. */
  attempt: z.number().int().nonnegative(),
  /** Zero-based iteration index for frames inside an iterate node. */
  iteration: z.number().int().nonnegative().optional(),
  /** Branch key for frames inside a parallel node. */
  branchKey: z.string().optional(),
  /** Epoch milliseconds when the frame started executing. */
  startedAt: z.number().optional(),
  /** Epoch milliseconds when the frame reached a terminal status. */
  completedAt: z.number().optional(),
  /** Wall-clock duration in milliseconds. */
  durationMs: z.number().nonnegative().optional(),
  /** Input tokens consumed (station frames with LLM execution). */
  inputTokens: z.number().int().nonnegative().optional(),
  /** Output tokens produced (station frames with LLM execution). */
  outputTokens: z.number().int().nonnegative().optional(),
  /** Estimated cost in USD (station frames with LLM execution). */
  estimatedCost: z.number().nonnegative().optional(),
  /** Human-readable error message when `status` is `'failed'`. */
  error: z.string().optional(),
});

export type WorkLogFrameEntry = z.infer<typeof WorkLogFrameEntrySchema>;

// ─────────────────────────────────────────────────────────────
// Artifact Write Event
// ─────────────────────────────────────────────────────────────

/**
 * A single artifact write event recorded in the WorkLog.
 *
 * Emitted when a node's execution produces an artifact revision.
 * Enables "show me all artifacts produced by this execution" queries
 * without scanning the artifact store.
 */
export const WorkLogArtifactWriteSchema = z.object({
  /** Execution that triggered the artifact write. */
  executionId: z.string().min(1),
  /** Frame that produced the artifact write. */
  frameId: z.string().min(1),
  /** Node identifier that declared the write. */
  nodeId: z.string().min(1),
  /** Artifact binding describing kind, schema version, and scope. */
  artifact: WorkflowArtifactBindingSchema,
  /**
   * Artifact revision identifier assigned by the artifact service on write.
   * Absent if the write is still in-flight or failed.
   */
  revision: z.string().min(1).optional(),
  /** Epoch milliseconds when the write was recorded. */
  writtenAt: z.number(),
});

export type WorkLogArtifactWrite = z.infer<typeof WorkLogArtifactWriteSchema>;

// ─────────────────────────────────────────────────────────────
// Gate Event
// ─────────────────────────────────────────────────────────────

/**
 * A gate lifecycle event recorded in the WorkLog.
 *
 * One entry per gate state transition. Enables "show me all pending gates
 * across executions" queries without scanning the full frame state.
 */
export const WorkLogGateEventSchema = z.object({
  /** Execution this gate belongs to. */
  executionId: z.string().min(1),
  /** Node identifier of the gate in the workflow definition. */
  nodeId: z.string().min(1),
  /** Frame identifier for the gate's execution frame. */
  frameId: z.string().min(1),
  /** Gate status at the time of this event. */
  status: z.enum(['waiting', 'resumed', 'rejected', 'timed-out', 'cancelled']),
  /**
   * Prompt shown to the reviewer, after template interpolation.
   * Populated when the gate entered `waiting` status.
   */
  prompt: z.string().optional(),
  /** Epoch milliseconds when the gate entered `waiting`. */
  openedAt: z.number(),
  /** Epoch milliseconds when the gate left `waiting`. */
  resolvedAt: z.number().optional(),
  /** JSON-serializable resume data submitted by the approver. */
  resumeData: JsonValueSchema.optional(),
});

export type WorkLogGateEvent = z.infer<typeof WorkLogGateEventSchema>;

// ─────────────────────────────────────────────────────────────
// Usage Summary
// ─────────────────────────────────────────────────────────────

/**
 * Aggregated token usage and cost summary for a workflow execution.
 *
 * Derived from frame-level telemetry. Not required for runtime progress;
 * used for billing dashboards and cost attribution.
 */
export const WorkLogUsageSummarySchema = z.object({
  /** Execution this summary applies to. */
  executionId: z.string().min(1),
  /** Total input tokens consumed across all station frames. */
  inputTokens: z.number().int().nonnegative(),
  /** Total output tokens produced across all station frames. */
  outputTokens: z.number().int().nonnegative(),
  /** Total cached tokens served from prompt cache (when available). */
  cachedTokens: z.number().int().nonnegative().optional(),
  /** Total estimated cost in USD. */
  estimatedCost: z.number().nonnegative(),
  /**
   * Per-model breakdown of usage.
   * Key is the model identifier; value is the usage for that model.
   */
  byModel: z
    .record(
      z.string(),
      z.object({
        /** Input tokens consumed by this model. */
        inputTokens: z.number().int().nonnegative(),
        /** Output tokens produced by this model. */
        outputTokens: z.number().int().nonnegative(),
        /** Estimated cost attributed to this model. */
        estimatedCost: z.number().nonnegative(),
      }),
    )
    .optional(),
});

export type WorkLogUsageSummary = z.infer<typeof WorkLogUsageSummarySchema>;

// ─────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────

/**
 * Aggregated WorkLog statistics over an optional time window.
 * All token/cost totals treat missing telemetry as zero.
 */
export const WorkLogStatsSchema = z.object({
  /** Number of executions matching the query. */
  total: z.number().int().nonnegative(),
  /** Execution counts per status (statuses without matches are 0). */
  byStatus: z.object({
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  /** Sum of wall-clock durations (terminal executions only). */
  totalDurationMs: z.number().nonnegative(),
  /** Sum of input tokens across matching executions. */
  totalInputTokens: z.number().int().nonnegative(),
  /** Sum of output tokens across matching executions. */
  totalOutputTokens: z.number().int().nonnegative(),
  /** Sum of estimated cost in USD across matching executions. */
  totalEstimatedCost: z.number().nonnegative(),
});

export type WorkLogStats = z.infer<typeof WorkLogStatsSchema>;

// ─────────────────────────────────────────────────────────────
// Dynamic Node Materialization Event
// ─────────────────────────────────────────────────────────────

/**
 * Records when a dynamic region's factory was invoked and produced nodes.
 *
 * Stored as a projection event so tooling can trace which factory produced
 * which nodes in a given execution, enabling debuggability of dynamically
 * generated pipelines.
 */
export const WorkLogDynamicNodeMaterializationSchema = z.object({
  /** Execution where the dynamic region was materialized. */
  executionId: z.string().min(1),
  /** Frame where materialization occurred. */
  frameId: z.string().min(1),
  /** Factory identifier from the `WorkflowDynamicRegion` descriptor. */
  factoryId: z.string().min(1),
  /**
   * JSON Schema of the materialized node IDs (in definition order).
   * Used to correlate frame entries back to the factory invocation.
   */
  materializedNodeIds: z.array(z.string().min(1)),
  /**
   * Optional JSON Schema passed to the factory at materialization time.
   * Stored for auditability; the schema is not re-validated by the WorkLog.
   */
  factoryInput: JsonSchemaRecordSchema.optional(),
  /** Epoch milliseconds when materialization occurred. */
  materializedAt: z.number(),
});

export type WorkLogDynamicNodeMaterialization = z.infer<typeof WorkLogDynamicNodeMaterializationSchema>;
