import { z } from 'zod';
import { AgentStatusSchema } from './schemas/agent.js';
import { AdapterSessionCurrencySnapshotSchema } from './schemas/adapter-session-currency.js';
import { AdapterSessionClaimStatusSchema } from './session-ownership-claim-status.js';

/** Exact runtime binding a recovery transfers to its replacement connector. */
export const RuntimeBindingSchema = z.object({
  adapterId: z.string(),
  ownerMachineId: z.string(),
  ownerInstanceId: z.string(),
});
/** {@inheritDoc RuntimeBindingSchema} */
export type RuntimeBinding = z.infer<typeof RuntimeBindingSchema>;

/** Durable row image restored when a recovery is refused before dispatch. */
export const SessionOwnershipRecoveryPreimageSchema = z
  .object({
    /** Exact lifecycle state the reservation replaces. */
    status: AgentStatusSchema,
    /** Adapter instance recorded before the recovery bound the replacement runtime. */
    adapterId: z.string(),
    binding: RuntimeBindingSchema.optional(),
    recoveryAttemptId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.binding !== undefined && value.binding.adapterId !== value.adapterId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binding', 'adapterId'],
        message: 'binding.adapterId must equal the preimage adapterId',
      });
    }
  });
/** {@inheritDoc SessionOwnershipRecoveryPreimageSchema} */
export type SessionOwnershipRecoveryPreimage = z.infer<typeof SessionOwnershipRecoveryPreimageSchema>;

/** Attempt and preimage created by one successful guarded reservation. */
export const SessionOwnershipRecoveryReservationSchema = z.object({
  attemptId: z.string(),
  preimage: SessionOwnershipRecoveryPreimageSchema,
});
/** {@inheritDoc SessionOwnershipRecoveryReservationSchema} */
export type SessionOwnershipRecoveryReservation = z.infer<typeof SessionOwnershipRecoveryReservationSchema>;

/** Terminal action for an attempt-fenced recovery lifecycle. */
export const SessionOwnershipRecoveryTerminalActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rollback'), preimage: SessionOwnershipRecoveryPreimageSchema }),
  z.object({ kind: z.literal('succeeded') }),
  z.object({ kind: z.literal('failed') }),
]);
/** {@inheritDoc SessionOwnershipRecoveryTerminalActionSchema} */
export type SessionOwnershipRecoveryTerminalAction = z.infer<typeof SessionOwnershipRecoveryTerminalActionSchema>;

/** Atomically terminalize a recovery only while its exact attempt still owns the row. */
export const SessionOwnershipFinalizeRecoveryRequestSchema = z.object({
  agentId: z.string(),
  attemptId: z.string(),
  binding: RuntimeBindingSchema,
  action: SessionOwnershipRecoveryTerminalActionSchema,
});
/** {@inheritDoc SessionOwnershipFinalizeRecoveryRequestSchema} */
export type SessionOwnershipFinalizeRecoveryRequest = z.infer<typeof SessionOwnershipFinalizeRecoveryRequestSchema>;

/** Result of an attempt-fenced recovery terminal transition. */
export const SessionOwnershipFinalizeRecoveryResponseSchema = z.object({ applied: z.boolean() });
/** {@inheritDoc SessionOwnershipFinalizeRecoveryResponseSchema} */
export type SessionOwnershipFinalizeRecoveryResult = z.infer<typeof SessionOwnershipFinalizeRecoveryResponseSchema>;

/** Exact generation observed on a key while recovery was planned. */
export const SessionOwnershipRecoveryOwnerGenerationSchema = z.object({
  /** Stable row identity observed by the recovery planner. */
  claimId: z.string(),
  /** Opaque identity of the observed claim generation. */
  claimToken: z.string(),
  /** Ordered fence of the observed generation. */
  fence: z.number().int().positive(),
  /** Runtime process that owns the observed generation. */
  ownerInstanceId: z.string().nullable(),
  /** Lifecycle state of the observed generation. */
  status: AdapterSessionClaimStatusSchema,
});
/** {@inheritDoc SessionOwnershipRecoveryOwnerGenerationSchema} */
export type SessionOwnershipRecoveryOwnerGeneration = z.infer<typeof SessionOwnershipRecoveryOwnerGenerationSchema>;

/** Snapshot a recovery reservation must replace atomically. */
export const SessionOwnershipRecoveryGuardSchema = z
  .object({
    /** Lifecycle status observed before planning the recovery. */
    expectedStatus: AgentStatusSchema,
    /** Exact adapter/runtime/attempt image the reservation will replace. */
    expectedPreimage: SessionOwnershipRecoveryPreimageSchema,
    /** Currency revision observed before planning. */
    expectedRevision: z.number().int().nonnegative(),
    /** Currency fence observed before planning. */
    expectedCurrencyFence: z.number().int().nonnegative(),
    /** Currency snapshot the recovery plan was derived from. */
    expectedCurrency: AdapterSessionCurrencySnapshotSchema,
    /** Exact generation observed on the requested key, or `null` when it was free. */
    ownerGeneration: SessionOwnershipRecoveryOwnerGenerationSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.expectedPreimage.status !== value.expectedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedPreimage', 'status'],
        message: 'expectedPreimage.status must equal expectedStatus',
      });
    }
  });
/** {@inheritDoc SessionOwnershipRecoveryGuardSchema} */
export type SessionOwnershipRecoveryGuard = z.infer<typeof SessionOwnershipRecoveryGuardSchema>;
