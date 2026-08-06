import { z } from 'zod';
import type { EventMessagePayload, SubjectDefinition } from '@makaio/core';
import { splitSubjectKey } from '@makaio/core';
import { WorkflowStationNodeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';

// ─────────────────────────────────────────────────────────────
// Node Type (lifecycle — observable node types)
// ─────────────────────────────────────────────────────────────

/**
 * Discriminant for all workflow node types that produce lifecycle events.
 * Used by lifecycle events and span records.
 *
 * Structural nodes (`sequence`, `parallel`, `iterate`, `iterate-chain`) are
 * excluded — they emit lifecycle events only as parent frames, not as runner
 * targets. `gate` is included because gate resolution events are observable.
 */
export const WorkflowStepTypeSchema = z.enum(['station', 'delegate-agent', 'delegate-role', 'gate']);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

// ─────────────────────────────────────────────────────────────
// Runner Node Type (runner-executable only)
// ─────────────────────────────────────────────────────────────

/**
 * Node types that are dispatchable to a {@link IStepRunner}.
 * Gates and delegation nodes are coordination steps handled by the orchestrator,
 * not dispatched to runners.
 */
export const WorkflowRunnerStepTypeSchema = z.enum(['station']);

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

/** Operational telemetry reported by workflow step executors. */
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
  const segments = splitSubjectKey(fullSubject);
  if (segments === undefined) {
    throw new Error(`Invalid step cancel subject: ${fullSubject}`);
  }

  return {
    subject: segments.subject,
    $meta: {
      namespace: segments.namespace,
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
  const segments = splitSubjectKey(fullSubject);
  if (segments === undefined) {
    throw new Error(`Invalid workflow cancel subject: ${fullSubject}`);
  }

  return {
    subject: segments.subject,
    $meta: {
      namespace: segments.namespace,
      isRequest: false,
      payload: {} as EventMessagePayload<WorkflowCancelPayload>,
      local: false,
      channel: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Step Run Config (input to the scheduler runStep callback)
// ─────────────────────────────────────────────────────────────

/**
 * Configuration passed through the scheduler runStep callback to execute a
 * single runner-dispatachable node.
 *
 * Internal API — only the Executor/Bridge creates these from a resolved,
 * runner-executable node. Structural nodes (`gate`, `sequence`, `parallel`,
 * `iterate`, `iterate-chain`) are orchestrator coordination nodes and are
 * never dispatched to runners.
 *
 * Uses {@link WorkflowRunnerStepTypeSchema} (`station`) — all other node
 * types are handled by the orchestrator directly.
 */
export const StepRunConfigSchema = z
  .object({
    /** Node (step) identifier within the workflow definition. */
    stepId: z.string().min(1),
    /** Execution ID of the running workflow. */
    executionId: z.string().min(1),
    /** Workflow definition ID. */
    workflowId: z.string().min(1),
    /** Coordinator session ID owning this execution. */
    coordinatorSessionId: z.string().min(1),
    /** Node type discriminant (runner-executable types only). */
    stepType: WorkflowRunnerStepTypeSchema,
    /** Resolved runner-executable station node definition. */
    stepDefinition: WorkflowStationNodeSchema,
    /** Expression context values resolved from previous node outputs and workflow inputs. */
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
// Cancellation constants
// ─────────────────────────────────────────────────────────────

/**
 * Human-readable reason string placed in step error fields and abort-signal
 * reasons when a workflow is cancelled.
 *
 * Used by orchestrators, step executors, worker-pool dispatch, and gate
 * coordinators to ensure consistent messaging across the execution pipeline.
 */
export const WORKFLOW_CANCELLED_REASON = 'Workflow cancelled';

// ─────────────────────────────────────────────────────────────
// Step Run Result (output from a workflow step executor)
// ─────────────────────────────────────────────────────────────

/**
 * Result produced after executing a workflow step.
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
 * Internal execution environment for runner-serializable workflow steps.
 *
 * Workflow-level isolation uses {@link IWorkflowRunner}. This interface remains
 * for the in-process scheduler path, where agent and shell steps still share a
 * uniform run/force-kill contract.
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
