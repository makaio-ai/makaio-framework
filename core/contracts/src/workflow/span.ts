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
 * A single step execution record in the OTel-style span model.
 *
 * Maps to the `workflow_step_spans` table. One row per step per execution.
 * Telemetry fields are populated from the terminal step result when the step
 * completes.
 */
export const SpanRecordSchema = z.object({
  /** Workflow execution this span belongs to. */
  executionId: z.string().min(1),
  /** Step identifier within the workflow definition. */
  stepId: z.string().min(1),
  /** Step type discriminant. */
  stepType: WorkflowStepTypeSchema,
  /** Current span status. */
  status: SpanStatusSchema,

  /** Step start timestamp (epoch ms). */
  startedAt: z.number().optional(),
  /** Step completion timestamp (epoch ms). */
  completedAt: z.number().optional(),
  /** Wall-clock duration in milliseconds. */
  durationMs: z.number().nonnegative().optional(),

  /** Input tokens consumed (agent steps). */
  inputTokens: z.number().int().nonnegative().optional(),
  /** Output tokens produced (agent steps). */
  outputTokens: z.number().int().nonnegative().optional(),
  /** Estimated cost in USD (agent steps). */
  estimatedCost: z.number().nonnegative().optional(),
  /** Number of tool calls (agent steps). */
  toolCallCount: z.number().int().nonnegative().optional(),

  /** Serialized step input (JSON string). */
  input: z.string().optional(),
  /** Serialized step output (JSON string). */
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
