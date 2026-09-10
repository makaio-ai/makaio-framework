import { z } from 'zod';
import { BoundedRecoveryEvidenceSchema } from '../capabilities/worker/types.js';

/** Immutable winning owner request, delivered without minting another control revision. */
export const ExecutionAttemptCancellationIntentSchema = z
  .object({
    requestKey: z.string().min(1),
    controlRevision: z.number().int().positive(),
    requestedAt: z.iso.datetime({ offset: true }),
    reason: z.string().optional(),
  })
  .strict();

/** Attempt-wide Cancel address; an operation is evidence scope, never the delivery address. */
export const ExecutionAttemptControlCorrelationSchema = z
  .object({
    executionAttemptId: z.string().min(1),
    runtimeIncarnationId: z.string().min(1),
    runtimeGeneration: z.number().int().positive(),
    controlRevision: z.number().int().positive(),
    requestKey: z.string().min(1),
  })
  .strict();

/** Authority reconciliation delivers the already accepted request to one registered incarnation. */
export const ExecutionAttemptControlDeliverySchema = ExecutionAttemptControlCorrelationSchema.omit({
  requestKey: true,
  controlRevision: true,
}).extend({ cancellation: ExecutionAttemptCancellationIntentSchema });

/** A runtime's first receipt instant, stable across redelivery; never a stop acknowledgement. */
export const ExecutionAttemptControlReceiptSchema = ExecutionAttemptControlCorrelationSchema.extend({
  receivedAt: z.iso.datetime({ offset: true }),
});

/** Refusal of delivery is not a manufactured negative stop report. */
export const ExecutionAttemptControlDeliveryResponseSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('received'), receipt: ExecutionAttemptControlReceiptSchema }).strict(),
  z.object({ decision: z.literal('refused'), reason: z.enum(['stale-generation', 'unsupported']) }).strict(),
]);

/**
 * A final, explicitly scoped observation. None of these boundaries means the
 * provider allocation ended, that remote side effects stopped, or that cleanup is authorized.
 */
export const ExecutionAttemptControlConclusionSchema = z
  .object({
    status: z.enum(['achieved', 'unsupported', 'unconfirmed']),
    boundary: z.enum(['admission-closed', 'setup-process-group', 'workload']),
    evidence: BoundedRecoveryEvidenceSchema,
  })
  .strict();

/** Runtime report remains separate from outcome.submit and does not complete its operation. */
export const ExecutionAttemptControlReportSchema = ExecutionAttemptControlCorrelationSchema.extend({
  operationId: z.string().min(1).optional(),
  conclusion: ExecutionAttemptControlConclusionSchema,
});

/** Correlation refusals do not invalidate the durable Attempt-wide Cancel. */
export const ExecutionAttemptControlRefusalReasonSchema = z.enum([
  'not-found',
  'cancel-mismatch',
  'stale-generation',
  'operation-mismatch',
  'conflict',
]);

/** A report can be acknowledged only after durable acceptance or exact replay. */
export const ExecutionAttemptControlReportResponseSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('accepted') }).strict(),
  z.object({ decision: z.literal('duplicate') }).strict(),
  z.object({ decision: z.literal('refused'), reason: ExecutionAttemptControlRefusalReasonSchema }).strict(),
]);

/** Exact accepted-request and runtime-generation correlation. */
export type ExecutionAttemptControlCorrelation = z.infer<typeof ExecutionAttemptControlCorrelationSchema>;
/** Authority-to-runtime Cancel delivery. */
export type ExecutionAttemptControlDelivery = z.infer<typeof ExecutionAttemptControlDeliverySchema>;
/** Persistable first receipt returned by the addressed runtime. */
export type ExecutionAttemptControlReceipt = z.infer<typeof ExecutionAttemptControlReceiptSchema>;
/** Receipt or explicit delivery refusal. */
export type ExecutionAttemptControlDeliveryResponse = z.infer<typeof ExecutionAttemptControlDeliveryResponseSchema>;
/** Explicitly bounded final observation of the requested stop. */
export type ExecutionAttemptControlConclusion = z.infer<typeof ExecutionAttemptControlConclusionSchema>;
/** Runtime-to-authority final technical observation. */
export type ExecutionAttemptControlReport = z.infer<typeof ExecutionAttemptControlReportSchema>;
/** Durable refusal reason for a correlated control fact. */
export type ExecutionAttemptControlRefusalReason = z.infer<typeof ExecutionAttemptControlRefusalReasonSchema>;
/** Durable report acceptance or correlation refusal. */
export type ExecutionAttemptControlReportResponse = z.infer<typeof ExecutionAttemptControlReportResponseSchema>;
