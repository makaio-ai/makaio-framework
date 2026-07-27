import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { JsonValueSchema } from '../shared/json-value.js';

/** Terminal execution states accepted by the finalization protocol. */
export const WorkflowTerminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

/** Durable terminal state selected before lifecycle finalizers run. */
export const WorkflowFinalizationIntentSchema = z
  .object({
    status: WorkflowTerminalStatusSchema,
    completedAt: z.number().int().nonnegative(),
    error: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

/** Durable claim delivered to one registered workflow finalizer. */
export const WorkflowFinalizationClaimSchema = z
  .object({
    executionId: z.string().min(1),
    workflowId: z.string().min(1),
    finalizerId: z.string().min(1),
    transitionKey: z.string().min(1),
    claimToken: z.string().min(1),
    intent: WorkflowFinalizationIntentSchema,
    claimedAt: z.number().int().nonnegative(),
  })
  .strict();

export type WorkflowTerminalStatus = z.infer<typeof WorkflowTerminalStatusSchema>;
export type WorkflowFinalizationIntent = z.infer<typeof WorkflowFinalizationIntentSchema>;
export type WorkflowFinalizationClaim = z.infer<typeof WorkflowFinalizationClaimSchema>;

/** Result returned after a finalizer durably accepts one transition for processing. */
export const WorkflowFinalizationDeliveryResultSchema = z.object({ accepted: z.boolean() }).strict();

const FINALIZER_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Stable identity for a workflow lifecycle finalizer. */
export const WorkflowFinalizerIdSchema = z
  .string()
  .regex(FINALIZER_ID_PATTERN, 'Workflow finalizer IDs must be lowercase dot, dash, or underscore separated names.');

/** Stable identity for a workflow lifecycle finalizer. */
export type WorkflowFinalizerId = z.infer<typeof WorkflowFinalizerIdSchema>;

/** Stable identity for an authority-owned delegate result finalizer. */
export const WorkflowDelegateResultFinalizerIdSchema = z
  .string()
  .regex(
    FINALIZER_ID_PATTERN,
    'Workflow delegate result finalizer IDs must be lowercase dot, dash, or underscore separated names.',
  );

/**
 * Runtime evidence available to an authority-owned delegate result finalizer.
 *
 * The workflow runtime currently has no subagent-scoped successful tool-call
 * ledger. It therefore always sends an empty list until that evidence is
 * explicitly made available by the subagent contract.
 */
export const WorkflowDelegateToolObservationSchema = z
  .object({
    /** Name of the completed tool call. */
    toolName: z.string().min(1),
    /** Explicit runtime outcome. Omitted only by legacy producers. */
    outcome: z.enum(['success', 'failure']).optional(),
    /** Authoritative typed Artifact identity, available only for successful Artifact operations. */
    artifact: z
      .object({ kind: z.string().min(1), id: z.string().min(1), revision: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.artifact !== undefined && observation.outcome !== 'success') {
      ctx.addIssue({ code: 'custom', path: ['artifact'], message: 'requires an explicit successful outcome' });
    }
  });
export type WorkflowDelegateToolObservation = z.infer<typeof WorkflowDelegateToolObservationSchema>;

/** Non-secret runtime economics and binding evidence for one successful delegate. */
export const WorkflowDelegateEconomicsSchema = z
  .object({
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    binding: z
      .object({
        adapterName: z.string().min(1),
        providerConfigId: z.string().min(1).optional(),
        providerDefinitionId: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        auth: z
          .object({
            mode: z.enum(['explicit', 'inferred', 'none']),
            owner: z.enum(['provider', 'client']),
            methodId: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

/** Authority request that finalizes one successful delegate result before frame persistence. */
export const WorkflowDelegateResultFinalizationRequestSchema = z
  .object({
    executionId: z.string().min(1),
    workflowId: z.string().min(1),
    frameId: z.string().min(1),
    nodeId: z.string().min(1),
    nodeType: z.enum(['delegate-agent', 'delegate-role']),
    rawResult: JsonValueSchema,
    toolObservations: z.array(WorkflowDelegateToolObservationSchema),
    economics: WorkflowDelegateEconomicsSchema.optional(),
  })
  .strict();

/**
 * Static authority gateway request for one delegate result finalization.
 *
 * Unlike the dynamically named finalizer subject, this envelope is safe to
 * expose to restricted remote execution attempts. The Authority validates the
 * selected finalizer against its durable definition snapshot before routing
 * the enclosed payload to the finalizer's local namespace.
 */
export const WorkflowDelegateResultFinalizationGatewayRequestSchema =
  WorkflowDelegateResultFinalizationRequestSchema.extend({
    finalizerId: WorkflowDelegateResultFinalizerIdSchema,
  }).strict();

/** Authority response containing the durable delegate frame output. */
export const WorkflowDelegateResultFinalizationResponseSchema = z.object({ output: JsonValueSchema }).strict();

export type WorkflowDelegateResultFinalizationRequest = z.infer<typeof WorkflowDelegateResultFinalizationRequestSchema>;
export type WorkflowDelegateResultFinalizationGatewayRequest = z.infer<
  typeof WorkflowDelegateResultFinalizationGatewayRequestSchema
>;
export type WorkflowDelegateEconomics = z.infer<typeof WorkflowDelegateEconomicsSchema>;
export type WorkflowDelegateResultFinalizationResponse = z.infer<
  typeof WorkflowDelegateResultFinalizationResponseSchema
>;

/**
 * Create the bus namespace owned by a workflow lifecycle finalizer.
 *
 * The engine may replay `finalize` with the same transition key and claim token
 * until storage acknowledges it. `{ accepted: true }` only confirms durable
 * acceptance; implementations must call `acknowledgeFinalization` or
 * `failFinalization` to settle the terminal transition.
 * @param finalizerId - Stable finalizer identity used for durable recovery ownership.
 * @returns Dynamic namespace and typed subjects for the finalizer.
 */
export function createWorkflowFinalizerNamespace(finalizerId: string) {
  const parsedFinalizerId = WorkflowFinalizerIdSchema.safeParse(finalizerId);
  if (!parsedFinalizerId.success) throw new Error(`Invalid workflow finalizer ID: "${finalizerId}"`);
  const namespaceDomain = `workflow-finalizer:${finalizerId}`;
  const namespace = createBusNamespace(namespaceDomain, {
    finalize: {
      request: WorkflowFinalizationClaimSchema,
      response: WorkflowFinalizationDeliveryResultSchema,
    },
  });
  return { namespaceDomain, namespace, subjects: namespace.subjects };
}

/**
 * Create the bus namespace owned by a delegate result finalizer.
 *
 * The worker calls this RPC only after a delegate completes successfully and
 * before its frame output is persisted or merged into downstream aggregation.
 * A rejection is a delegate failure; the runtime deliberately does not retry
 * the request because finalizers may have externally visible side effects.
 * @param finalizerId - Stable selector serialized on a delegate node.
 * @returns Dynamic namespace and typed finalization subject.
 */
export function createWorkflowDelegateResultFinalizerNamespace(finalizerId: string) {
  const parsedFinalizerId = WorkflowDelegateResultFinalizerIdSchema.safeParse(finalizerId);
  if (!parsedFinalizerId.success) throw new Error(`Invalid workflow delegate result finalizer ID: "${finalizerId}"`);
  const namespaceDomain = `workflow-delegate-finalizer:${finalizerId}`;
  const namespace = createBusNamespace(namespaceDomain, {
    finalize: {
      request: WorkflowDelegateResultFinalizationRequestSchema,
      response: WorkflowDelegateResultFinalizationResponseSchema,
    },
  });
  return { namespaceDomain, namespace, subjects: namespace.subjects };
}
