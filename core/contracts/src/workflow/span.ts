import { z } from 'zod';
import { WorkflowStepTypeSchema } from './step-runner.js';

// ─────────────────────────────────────────────────────────────
// Span Record (OTel-style step execution trace)
// ─────────────────────────────────────────────────────────────

/**
 * Span status values — terminal states for a step within an execution trace.
 */
export const SpanStatusSchema = z.enum(['running', 'completed', 'failed', 'skipped']);

export type SpanStatus = z.infer<typeof SpanStatusSchema>;

/**
 * A single node execution record in the OTel-style span model.
 *
 * One row per observable execution frame. `stepId` names the workflow node for
 * grouping/display, while `frameId` uniquely identifies this concrete node run.
 * Telemetry fields are populated from the terminal frame result when the node
 * completes.
 */
export const SpanRecordSchema = z.object({
  /** Workflow execution this span belongs to. */
  executionId: z.string().min(1),
  /** Runtime frame identifier for this concrete node execution. */
  frameId: z.string().min(1),
  /** Node (step) identifier within the workflow definition. */
  stepId: z.string().min(1),
  /** Node type discriminant. */
  stepType: WorkflowStepTypeSchema,
  /** Current span status. */
  status: SpanStatusSchema,

  /** Node start timestamp (epoch ms). */
  startedAt: z.number().optional(),
  /** Node completion timestamp (epoch ms). */
  completedAt: z.number().optional(),
  /** Wall-clock duration in milliseconds. */
  durationMs: z.number().nonnegative().optional(),

  /** Input tokens consumed (station nodes with LLM execution). */
  inputTokens: z.number().int().nonnegative().optional(),
  /** Output tokens produced (station nodes with LLM execution). */
  outputTokens: z.number().int().nonnegative().optional(),
  /** Estimated cost in USD (station nodes with LLM execution). */
  estimatedCost: z.number().nonnegative().optional(),
  /** Number of tool calls made during execution (station nodes). */
  toolCallCount: z.number().int().nonnegative().optional(),

  /** Serialized node input (JSON string). */
  input: z.string().optional(),
  /** Serialized node output (JSON string). */
  output: z.string().optional(),
});

export type SpanRecord = z.infer<typeof SpanRecordSchema>;

// ─────────────────────────────────────────────────────────────
// Execution Link (cross-execution references)
// ─────────────────────────────────────────────────────────────

/**
 * Link type between workflow executions.
 */
export const ExecutionLinkTypeSchema = z.enum(['triggered-by', 'feedback-loop']);

export type ExecutionLinkType = z.infer<typeof ExecutionLinkTypeSchema>;

/**
 * A directed link between two workflow executions.
 *
 * Enables pipeline-level tracing across execution boundaries:
 * "Show me the full trace for Issue #42" — from requirements through QA.
 */
export const ExecutionLinkSchema = z.object({
  /** Execution that caused the link (e.g., the execution whose output triggered a new run). */
  sourceExecutionId: z.string().min(1),
  /** Execution that was created as a result. */
  targetExecutionId: z.string().min(1),
  /** Relationship type. */
  linkType: ExecutionLinkTypeSchema,
  /** Optional metadata (e.g., reason, target station). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionLink = z.infer<typeof ExecutionLinkSchema>;

/**
 * Query parameters for listing execution links.
 * At least one of `sourceExecutionId` or `targetExecutionId` is required to avoid unbounded scans.
 */
export const ExecutionLinkListQuerySchema = z
  .object({
    /** Filter by link source execution. */
    sourceExecutionId: z.string().min(1).optional(),
    /** Filter by link target execution. */
    targetExecutionId: z.string().min(1).optional(),
  })
  .refine((query) => query.sourceExecutionId !== undefined || query.targetExecutionId !== undefined, {
    message: 'Either sourceExecutionId or targetExecutionId is required.',
  });

export type ExecutionLinkListQuery = z.infer<typeof ExecutionLinkListQuerySchema>;
