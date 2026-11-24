import { z } from 'zod';
import type { EventMessagePayload, SubjectDefinition } from '@makaio/core';
import { splitSubjectKey } from '@makaio/core';
import { WorkflowAgentStepNodeSchema, WorkflowCodeStepNodeSchema, WorkflowNodeTypeSchema } from './schemas.js';
import { JsonValueSchema } from '../shared/json-value.js';
import { CodeStepDataSchema } from './code-step-context.js';
import { StepIdSchema } from './identifiers.js';

// ─────────────────────────────────────────────────────────────
// Node Type (lifecycle — observable node types)
// ─────────────────────────────────────────────────────────────

/**
 * Node types that produce lifecycle events and span records.
 * Derived from {@link WorkflowNodeTypeSchema}.
 *
 * Structural nodes emit lifecycle events as parent frames.
 */
export const WorkflowStepTypeSchema = WorkflowNodeTypeSchema.extract(['code-step', 'agent-step']);

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;

// ─────────────────────────────────────────────────────────────
// Runner Node Type (runner-executable only)
// ─────────────────────────────────────────────────────────────

/**
 * Node types that are dispatchable to a {@link IStepRunner}.
 * Derived from {@link WorkflowStepTypeSchema}.
 * The worker dispatches either step kind through the same runner.
 */
export const WorkflowRunnerStepTypeSchema = WorkflowStepTypeSchema;

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

const StepRunBaseSchema = z.strictObject({
  /** Node identifier within the workflow definition. */
  stepId: StepIdSchema,
  /** Execution frame for this occurrence of the step. */
  frameId: z.string().min(1).optional(),
  /** Frozen run data and current sequence or iteration context. */
  data: CodeStepDataSchema,
  /** Working directory for the step. Launch environment belongs to the runner. */
  platformDefaults: StepRunnerPlatformDefaultsSchema.pick({ cwd: true }).strict(),
});

/** One executable step and its data, independent of the worker's transport and lifecycle. */
export const StepRunConfigSchema = z
  .discriminatedUnion('stepType', [
    StepRunBaseSchema.extend({
      stepType: z.literal('code-step'),
      stepDefinition: WorkflowCodeStepNodeSchema,
    }),
    StepRunBaseSchema.extend({
      stepType: z.literal('agent-step'),
      stepDefinition: WorkflowAgentStepNodeSchema,
      /** Prompt rendered in the execution scope before dispatch. */
      resolvedPrompt: z.string(),
    }),
  ])
  .refine((config) => config.stepId === config.stepDefinition.id, {
    message: 'The step identifier must match the step definition',
    path: ['stepId'],
  });

export type StepRunConfig = z.infer<typeof StepRunConfigSchema>;

// ─────────────────────────────────────────────────────────────
// Cancellation constants
// ─────────────────────────────────────────────────────────────

/**
 * Human-readable reason string placed in step error fields and abort-signal
 * reasons when a workflow is cancelled.
 *
 * Used by orchestrators, step executors, and worker-pool dispatch to ensure
 * consistent messaging across the execution pipeline.
 */
export const WORKFLOW_CANCELLED_REASON = 'Workflow cancelled';

// ─────────────────────────────────────────────────────────────
// Step Run Result (output from a workflow step executor)
// ─────────────────────────────────────────────────────────────

/** Stable failure codes returned across the workflow step runner boundary. */
export const StepRunErrorCodeSchema = z.enum([
  'environmentMissing',
  'unknownRole',
  'invalidOutput',
  'timeLimit',
  'requestRefusalObserverFailed',
  'agentCapabilitiesUnsupported',
  'sourceNotPrepared',
  'promptTooLarge',
  'agentStartRefused',
  'agentTurnFailed',
  'processFailed',
  'requestInvalid',
  'requestTooLarge',
  'modelNotInSession',
  'upstreamFailed',
  'replyInvalid',
  'streamingUnsupported',
  'modelUnreachable',
  'requestTimedOut',
  'sourceMismatch',
  'notExecutable',
  'handlerUnavailable',
  'loopCheckMultiple',
  'stepExecutionFailed',
  'stepProcessCleanupFailed',
  'unexpectedStepOutcome',
]);

/** Machine-readable Step Runner failure. */
export type StepRunErrorCode = z.infer<typeof StepRunErrorCodeSchema>;

/**
 * Result produced after executing a workflow step.
 * Contains both the functional output and operational telemetry.
 *
 * No cross-field refinement between status and error: a failed step
 * may lack an error code (OOM-kill, signal termination), and error
 * is informational — the consumer dispatches on status alone.
 */
export const StepRunResultSchema = z.object({
  /** Terminal step status. */
  status: z.enum(['completed', 'failed', 'cancelled']),
  /** Functional output of the step (JSON-serializable). */
  output: JsonValueSchema.optional(),
  /** Machine-readable error when execution fails. */
  error: StepRunErrorCodeSchema.optional(),
  /** Optional caller-local diagnostic, separate from the failure code. */
  detail: z.string().optional(),
  /** Operational telemetry collected during step execution. */
  telemetry: StepTelemetrySchema,
});

export type StepRunResult = z.infer<typeof StepRunResultSchema>;

// ─────────────────────────────────────────────────────────────
// StepRunner interface (type-only, no Zod)
// ─────────────────────────────────────────────────────────────

/** Execution port for code and agent steps, owned by the worker runtime. */
export interface IStepRunner {
  /**
   * Execute a workflow step in an isolated environment.
   * @param config - Step definition and resolved inputs
   * @param signal - AbortSignal for cooperative cancellation; abort triggers graceful shutdown
   * @returns Step result with functional output and operational telemetry
   */
  run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult>;

  /**
   * Request immediate termination of active instances of this step.
   * Called after the cancellation grace period expires without the step completing.
   * @param executionId - Execution ID owning the step
   * @param stepId - Identifier of the step to kill
   */
  forceKill?(executionId: string, stepId: string): void | Promise<void>;

  /**
   * Release resources held by this runner (thread pools, connections).
   */
  dispose?(): Promise<void>;
}
