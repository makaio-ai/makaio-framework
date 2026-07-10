import { z } from 'zod';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { WorkflowExecutionScopeSchema } from './schemas.js';
import { WorkflowStepTypeSchema } from './step-runner.js';

/** Reserved identifier prefix for executions owned by the external lifecycle API. */
export const EXTERNAL_EXECUTION_ID_PREFIX = 'wfx-ext-';

/**
 * Frame metadata persisted atomically when an external execution is registered.
 *
 * `frameId`, `path`, and `startedAt` may be omitted so the workflow service can
 * derive stable defaults after it allocates the execution identifier. The
 * resolved values are returned and durably written before registration is
 * acknowledged.
 */
export const ExternalExecutionFrameStartSchema = z
  .object({
    /** Stable frame identifier. Defaults to `<executionId>:<nodeId>`. */
    frameId: z.string().min(1).optional(),
    /** Node identifier represented by the frame. */
    nodeId: z.string().min(1),
    /** Observable workflow node type. */
    nodeType: WorkflowStepTypeSchema,
    /** Frame-tree path. Defaults to `[frameId]`. */
    path: z.array(z.string().min(1)).optional(),
    /** Zero-based attempt index. */
    attempt: z.number().int().nonnegative().default(0),
    /** Zero-based iteration index, when applicable. */
    iteration: z.number().int().nonnegative().optional(),
    /** Parallel-branch key, when applicable. */
    branchKey: z.string().min(1).optional(),
    /** Frame start timestamp. Defaults to the external execution start. */
    startedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Inferred external frame registration metadata. */
export type ExternalExecutionFrameStart = z.infer<typeof ExternalExecutionFrameStartSchema>;

/**
 * Exact frame metadata supplied when an external execution settles.
 *
 * The workflow service derives the terminal frame status, completion timestamp,
 * duration, and failure text from the enclosing completion request, then writes
 * the execution, WorkLog summary, and frame in one transaction.
 */
export const ExternalExecutionFrameCompletionSchema = z
  .object({
    /** Stable frame identifier returned by registration. */
    frameId: z.string().min(1),
    /** Node identifier represented by the frame. */
    nodeId: z.string().min(1),
    /** Observable workflow node type. */
    nodeType: WorkflowStepTypeSchema,
    /** Exact frame-tree path. */
    path: z.array(z.string().min(1)),
    /** Zero-based attempt index. */
    attempt: z.number().int().nonnegative().default(0),
    /** Zero-based iteration index, when applicable. */
    iteration: z.number().int().nonnegative().optional(),
    /** Parallel-branch key, when applicable. */
    branchKey: z.string().min(1).optional(),
    /** Exact frame start timestamp. */
    startedAt: z.number().int().nonnegative(),
    /** Optional asserted duration; must equal `completedAt - startedAt`. */
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Inferred external frame completion metadata. */
export type ExternalExecutionFrameCompletion = z.infer<typeof ExternalExecutionFrameCompletionSchema>;

/** Request contract for atomic external execution registration. */
export const RegisterExternalExecutionRequestSchema = z.object({
  /** Stable caller-supplied ID for idempotent replay. Generated when omitted. */
  executionId: z
    .string()
    .startsWith(EXTERNAL_EXECUTION_ID_PREFIX, { message: 'executionId must use the wfx-ext- prefix' })
    .optional(),
  /** Human-readable label stored as the external execution's workflow ID. */
  name: z.string().min(1),
  /** Execution start timestamp. Defaults to `Date.now()`. */
  startedAt: z.number().int().nonnegative().optional(),
  /** Scope for the execution. Defaults to global when omitted. */
  scope: WorkflowExecutionScopeSchema.optional(),
  /** Optional artifact binding reference. */
  artifactRef: WorkflowArtifactRefSchema.optional(),
  /** Optional bound input value for the execution. */
  input: JsonValueSchema.optional(),
  /** Optional trigger payload metadata. */
  triggerPayload: JsonObjectContractSchema.optional(),
  /** Optional frame persisted in the same transaction as the execution. */
  frame: ExternalExecutionFrameStartSchema.optional(),
});

/** Parsed external execution registration request. */
export type RegisterExternalExecutionRequest = z.infer<typeof RegisterExternalExecutionRequestSchema>;

/** Request contract for atomic, idempotent external execution settlement. */
export const CompleteExternalExecutionRequestSchema = z
  .object({
    /** Execution identifier returned by registration. */
    executionId: z.string().min(1),
    /** Terminal execution status. */
    status: z.enum(['completed', 'failed', 'cancelled']),
    /** Required failure text for failed settlements. */
    error: z.string().min(1).optional(),
    /** Required cancellation reason for cancelled settlements. */
    reason: z.string().min(1).optional(),
    /** Completion timestamp. Defaults transactionally when frame metadata is absent. */
    completedAt: z.number().int().nonnegative().optional(),
    /** Optional exact frame settled in the same transaction. */
    frame: ExternalExecutionFrameCompletionSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.status === 'failed' && payload.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'failed' requires a non-empty 'error' message",
        path: ['error'],
      });
    }
    if (payload.status === 'cancelled' && payload.reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'cancelled' requires a non-empty 'reason' string",
        path: ['reason'],
      });
    }
    if (payload.status === 'failed' && payload.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'failed' must not carry a 'reason'",
        path: ['reason'],
      });
    }
    if (payload.status === 'cancelled' && payload.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'cancelled' must not carry an 'error'",
        path: ['error'],
      });
    }
    if (payload.status === 'completed' && payload.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'completed' must not carry an 'error'",
        path: ['error'],
      });
    }
    if (payload.status === 'completed' && payload.reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status 'completed' must not carry a 'reason'",
        path: ['reason'],
      });
    }
    if (payload.frame !== undefined && payload.completedAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completedAt is required when frame metadata is supplied',
        path: ['completedAt'],
      });
    }
    if (payload.frame !== undefined && payload.completedAt !== undefined) {
      const durationMs = payload.completedAt - payload.frame.startedAt;
      if (durationMs < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'completedAt must not precede frame.startedAt',
          path: ['completedAt'],
        });
      }
      if (payload.frame.durationMs !== undefined && payload.frame.durationMs !== durationMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'frame.durationMs must equal completedAt - frame.startedAt',
          path: ['frame', 'durationMs'],
        });
      }
    }
  });

/** Parsed external execution completion request. */
export type CompleteExternalExecutionRequest = z.infer<typeof CompleteExternalExecutionRequestSchema>;
