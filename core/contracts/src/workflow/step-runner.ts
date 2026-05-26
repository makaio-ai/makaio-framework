import { z } from 'zod';
import type { EventMessagePayload, SubjectDefinition } from '@makaio/core';
import { AgentWorkflowStepSchema, ShellWorkflowStepSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';

// ─────────────────────────────────────────────────────────────
// Step Type (lifecycle — includes gate for spans/events)
// ─────────────────────────────────────────────────────────────

/**
 * Discriminant for all workflow step execution types, including gate and function.
 * Used by lifecycle events and span records where gate steps participate.
 * Matches the `type` discriminant on {@link WorkflowStepSchema} variants.
 *
 * `function` steps run in the worker orchestrator (not the main-process scheduler)
 * and emit lifecycle events on the worker-local bus for observability.
 * Composite `for-each` steps are excluded — they are scheduler coordination nodes,
 * not executor targets.
 */
export const WorkflowStepTypeSchema = z.enum(['agent', 'shell', 'gate', 'function', 'bus-request']);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

// ─────────────────────────────────────────────────────────────
// Runner Step Type (excludes gate — runner-executable only)
// ─────────────────────────────────────────────────────────────

/**
 * Step types that are executable by a {@link IStepRunner}.
 * Gates are coordination steps handled by the orchestrator, not dispatched to runners.
 */
export const WorkflowRunnerStepTypeSchema = z.enum(['agent', 'shell']);

export type WorkflowRunnerStepType = z.infer<typeof WorkflowRunnerStepTypeSchema>;

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
// Bus Auth (typed discriminated union)
// ─────────────────────────────────────────────────────────────

/**
 * Bus authentication strategy for the worker connection.
 * Discriminated on `kind`:
 * - `none`: no authentication (local/trusted environments)
 * - `hmac`: shared-secret HMAC signing
 */
export const StepRunnerBusAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('hmac'), secret: z.string().min(1) }).strict(),
]);

export type StepRunnerBusAuth = z.infer<typeof StepRunnerBusAuthSchema>;

// ─────────────────────────────────────────────────────────────
// Platform Defaults
// ─────────────────────────────────────────────────────────────

/**
 * Platform-level defaults inherited from the coordinator session.
 * Provides the working directory and optional base environment
 * for runner process creation.
 */
export const StepRunnerPlatformDefaultsSchema = z.object({
  /** Working directory for the step process. */
  cwd: z.string().min(1),
  /** Optional base environment variables merged into the step process. */
  env: z.record(z.string(), z.string()).optional(),
});

export type StepRunnerPlatformDefaults = z.infer<typeof StepRunnerPlatformDefaultsSchema>;

// ─────────────────────────────────────────────────────────────
// Step Cancellation Event
// ─────────────────────────────────────────────────────────────

/** Payload emitted on a step runner's cancellation subject. */
export const StepCancelPayloadSchema = z.object({
  /** Execution ID owning the cancelled step. */
  executionId: z.string().min(1),
  /** Step ID being cancelled. */
  stepId: z.string().min(1),
  /** Optional human-readable cancellation reason. */
  reason: z.string().optional(),
});

export type StepCancelPayload = z.infer<typeof StepCancelPayloadSchema>;

export type StepCancelSubject = SubjectDefinition<Record<string, StepCancelPayload>, string, string>;

/**
 * Build an ad-hoc event subject definition for a runner cancellation channel.
 *
 * Cancellation subjects are per step (`workflow.{execution}.step.{step}.cancel`)
 * and therefore cannot be statically enumerated in the workflow namespace.
 * They intentionally follow the same ad-hoc subject pattern used by direct
 * channels: no registered Zod schema, but a typed in-process definition for
 * bus routing across transports.
 * @param fullSubject - Fully qualified subject in `namespace.subject` form.
 * @returns Event subject definition for bus emit/on calls.
 */
export function createStepCancelSubject(fullSubject: string): StepCancelSubject {
  const separator = fullSubject.indexOf('.');
  if (separator <= 0 || separator === fullSubject.length - 1) {
    throw new Error(`Invalid step cancel subject: ${fullSubject}`);
  }

  return {
    subject: fullSubject.slice(separator + 1),
    $meta: {
      namespace: fullSubject.slice(0, separator),
      isRequest: false,
      payload: {} as EventMessagePayload<StepCancelPayload>,
      local: false,
      channel: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Workflow Cancellation Event
// ─────────────────────────────────────────────────────────────

/** Payload emitted on a workflow worker's cancellation subject. */
export const WorkflowCancelPayloadSchema = z.object({
  /** Execution ID being cancelled. */
  executionId: z.string().min(1),
  /** Optional human-readable cancellation reason. */
  reason: z.string().optional(),
});

export type WorkflowCancelPayload = z.infer<typeof WorkflowCancelPayloadSchema>;

export type WorkflowCancelSubject = SubjectDefinition<Record<string, WorkflowCancelPayload>, string, string>;

/**
 * Build an ad-hoc event subject definition for a workflow worker cancellation channel.
 *
 * Cancellation subjects are per execution (`workflow.{executionId}.cancel`) and
 * therefore cannot be statically enumerated in the workflow namespace. They follow
 * the same ad-hoc subject pattern as step cancellation: no registered Zod schema,
 * but a typed in-process definition for bus routing across transports.
 * @param fullSubject - Fully qualified subject in `namespace.subject` form,
 *   e.g. `workflow.{executionId}.cancel`.
 * @returns Event subject definition for bus emit/on calls.
 */
export function createWorkflowCancelSubject(fullSubject: string): WorkflowCancelSubject {
  const separator = fullSubject.indexOf('.');
  if (separator <= 0 || separator === fullSubject.length - 1) {
    throw new Error(`Invalid workflow cancel subject: ${fullSubject}`);
  }

  return {
    subject: fullSubject.slice(separator + 1),
    $meta: {
      namespace: fullSubject.slice(0, separator),
      isRequest: false,
      payload: {} as EventMessagePayload<WorkflowCancelPayload>,
      local: false,
      channel: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Step Run Config (input to a StepRunner)
// ─────────────────────────────────────────────────────────────

/**
 * Configuration passed to a {@link IStepRunner} to execute a single step.
 *
 * Internal API — only the Executor/Bridge creates these from a resolved,
 * runner-executable WorkflowStep. Runtime `gate` and `for-each` scheduler
 * nodes are coordination steps, not runner targets.
 *
 * Uses {@link WorkflowRunnerStepTypeSchema} (agent | shell) — gate steps are
 * coordination steps handled by the orchestrator, never dispatched to runners.
 */
const WorkflowRunnerStepSchema = z.discriminatedUnion('type', [AgentWorkflowStepSchema, ShellWorkflowStepSchema]);

export const StepRunConfigSchema = z
  .object({
    /** Step identifier within the workflow definition. */
    stepId: z.string().min(1),
    /** Execution ID of the running workflow. */
    executionId: z.string().min(1),
    /** Workflow definition ID. */
    workflowId: z.string().min(1),
    /** Coordinator session ID owning this execution. */
    coordinatorSessionId: z.string().min(1),
    /** Step type discriminant (runner-executable types only). */
    stepType: WorkflowRunnerStepTypeSchema,
    /** Resolved runner-executable step definition from the workflow DAG. */
    stepDefinition: WorkflowRunnerStepSchema,
    /** Expression context values resolved from previous step outputs and workflow inputs. */
    resolvedInputs: JsonObjectContractSchema,
    /** Bus server WebSocket URL for the worker to connect to. */
    busUrl: z.string().optional(),
    /** Bus authentication strategy. Defaults to `{ kind: 'none' }` when omitted. */
    busAuth: StepRunnerBusAuthSchema.default({ kind: 'none' }),
    /** Platform-level defaults inherited from the coordinator session. */
    platformDefaults: StepRunnerPlatformDefaultsSchema,
    /** Bus subject the worker subscribes to for cancellation signals. */
    cancelSubject: z.string().min(1),
  })
  .superRefine((config, ctx) => {
    if (config.stepType === config.stepDefinition.type) return;
    ctx.addIssue({
      code: 'custom',
      path: ['stepDefinition', 'type'],
      message: `stepDefinition.type must match stepType (${config.stepType})`,
    });
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
  output: JsonValueSchema.optional(),
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
   * Whether this runner manages the full workflow lifecycle (bus subscriptions,
   * session creation, etc.) or delegates that to the orchestrator.
   *
   * - `true`: Runner creates its own bus connection, manages session lifecycle
   *   (e.g., Docker/Lambda runners that are fully self-contained).
   * - `false`: Orchestrator manages the bus connection and session; runner
   *   only executes the step process (e.g., Piscina thread pool runner).
   */
  readonly managesWorkflowLifecycle: boolean;

  /**
   * Execute a workflow step in an isolated environment.
   * @param config - Step configuration including definition, inputs, and bus connection info
   * @param signal - AbortSignal for cooperative cancellation; abort triggers graceful shutdown
   * @returns Step result with functional output and operational telemetry
   */
  run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult>;

  /**
   * Force-kill a running step immediately (SIGKILL / container stop).
   * Called after the AbortSignal grace period expires without the step completing.
   * @param executionId - Execution ID owning the step
   * @param stepId - Identifier of the step to kill
   */
  forceKill?(executionId: string, stepId: string): void | Promise<void>;

  /**
   * Release resources held by this runner (thread pools, connections).
   */
  dispose?(): Promise<void>;
}
