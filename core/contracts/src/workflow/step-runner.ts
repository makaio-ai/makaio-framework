import { z } from 'zod';
import { WorkflowStepSchema } from './schemas.js';

// ─────────────────────────────────────────────────────────────
// Step Type
// ─────────────────────────────────────────────────────────────

/**
 * Discriminant for workflow step execution types.
 * Matches the `type` discriminant on {@link WorkflowStepSchema} variants.
 */
export const WorkflowStepTypeSchema = z.enum(['agent', 'shell', 'gate']);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

// ─────────────────────────────────────────────────────────────
// Step Telemetry
// ─────────────────────────────────────────────────────────────

/**
 * Token usage breakdown for an agent step.
 */
export const TokenUsageSchema = z.object({
  /** Input tokens consumed. */
  input: z.number().int().nonnegative(),
  /** Output tokens produced. */
  output: z.number().int().nonnegative(),
  /** Tokens served from cache (prompt caching). */
  cached: z.number().int().nonnegative().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Operational telemetry collected by the {@link StepTelemetryCollector}
 * running on the step worker's local bus.
 */
export const StepTelemetrySchema = z.object({
  /** Wall-clock duration in milliseconds. */
  duration: z.number().nonnegative(),
  /** Token usage breakdown (agent steps only). */
  tokenUsage: TokenUsageSchema.optional(),
  /** Estimated cost in USD (agent steps only). */
  estimatedCost: z.number().nonnegative().optional(),
  /** Number of tool calls made by the agent (agent steps only). */
  toolCalls: z.number().int().nonnegative().optional(),
});

export type StepTelemetry = z.infer<typeof StepTelemetrySchema>;

// ─────────────────────────────────────────────────────────────
// Step Run Config (input to a StepRunner)
// ─────────────────────────────────────────────────────────────

/**
 * Configuration passed to a {@link StepRunner} to execute a single step.
 *
 * Internal API — only the Executor/Bridge creates these from a resolved
 * WorkflowStep. No cross-field refinement between stepType and
 * stepDefinition.type: the Executor sets both from the same source, and
 * for-each steps are expanded before reaching the runner, so the enum
 * domains intentionally differ.
 */
export const StepRunConfigSchema = z.object({
  /** Step identifier within the workflow definition. */
  stepId: z.string().min(1),
  /** Execution ID of the running workflow. */
  executionId: z.string().min(1),
  /** Workflow definition ID. */
  workflowId: z.string().min(1),
  /** Step type discriminant. */
  stepType: WorkflowStepTypeSchema,
  /** Resolved step definition from the workflow DAG. */
  stepDefinition: WorkflowStepSchema,
  /** Expression context values resolved from previous step outputs and workflow inputs. */
  resolvedInputs: z.record(z.string(), z.unknown()),
  /** Bus server WebSocket URL for the worker to connect to. */
  busUrl: z.string().optional(),
  /** Bus authentication credentials for the worker connection. */
  busAuth: z.record(z.string(), z.unknown()).optional(),
});

export type StepRunConfig = z.infer<typeof StepRunConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Step Run Result (output from a StepRunner)
// ─────────────────────────────────────────────────────────────

/**
 * Result produced by a {@link StepRunner} after executing a step.
 * Contains both the functional output and operational telemetry.
 *
 * No cross-field refinement between status and error: a failed step
 * may lack an error string (OOM-kill, signal termination), and error
 * is informational — the consumer dispatches on status alone.
 */
export const StepRunResultSchema = z.object({
  /** Terminal step status. */
  status: z.enum(['completed', 'failed']),
  /** Functional output of the step (JSON-serializable). */
  output: z.unknown().optional(),
  /** Error message when status is 'failed'. Absent when no diagnostic is available. */
  error: z.string().optional(),
  /** Operational telemetry collected during step execution. */
  telemetry: StepTelemetrySchema,
});

export type StepRunResult = z.infer<typeof StepRunResultSchema>;

// ─────────────────────────────────────────────────────────────
// StepRunner interface (type-only, no Zod)
// ─────────────────────────────────────────────────────────────

/**
 * Pluggable execution environment for workflow steps.
 *
 * Each implementation determines WHERE and HOW a step process runs:
 * - {@link PiscinaStepRunner}: local worker thread via Piscina
 * - {@link ContainerStepRunner}: Docker container (future)
 * - {@link LambdaStepRunner}: AWS Lambda function (future)
 * @see The memo `docs/memos/2026-05-22-workflow-abstraction-layer.md` for design rationale.
 */
export interface IStepRunner {
  /**
   * Execute a workflow step in an isolated environment.
   * @param config - Step configuration including definition, inputs, and bus connection info
   * @returns Step result with functional output and operational telemetry
   */
  run(config: StepRunConfig): Promise<StepRunResult>;

  /**
   * Release resources held by this runner (thread pools, connections).
   */
  dispose?(): Promise<void>;
}
