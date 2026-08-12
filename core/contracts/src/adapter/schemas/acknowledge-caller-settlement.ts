import { z } from 'zod';

/** Why an adapter refused a caller-owned settlement acknowledgement. */
export const CallerSettlementAckRefusalSchema = z.enum([
  'not-hosted',
  'stale-token',
  'teardown-in-flight',
  'status-refused',
]);

/** {@inheritDoc CallerSettlementAckRefusalSchema} */
export type CallerSettlementAckRefusal = z.infer<typeof CallerSettlementAckRefusalSchema>;

/**
 * Acknowledge that a caller-owned start or rehydrate durably settled ownership.
 *
 * The opaque token binds the acknowledgement to the exact hosted generation
 * returned by `adapter.startAgent` or `adapter.rehydrateAgent`. The adapter
 * opens provider-key publication and accepts responsibility for later terminal
 * row writes only after this RPC succeeds.
 */
export const AcknowledgeCallerSettlementSchema = {
  request: z.object({
    /** Adapter instance hosting the generation. */
    adapterId: z.string(),
    /** Exact runtime incarnation hosting the generation. */
    ownerInstanceId: z.string(),
    /** Agent whose hosted generation is being acknowledged. */
    agentId: z.string(),
    /** Opaque generation token returned by the successful dispatch. */
    settlementAckToken: z.string(),
    /** Recovery ownership finalizes the durable row after this registry acknowledgement. */
    recovery: z.literal(true).optional(),
  }),
  response: z.discriminatedUnion('acknowledged', [
    z.object({ acknowledged: z.literal(true) }),
    z.object({
      acknowledged: z.literal(false),
      reason: CallerSettlementAckRefusalSchema,
    }),
  ]),
};

export type AcknowledgeCallerSettlementRequest = z.infer<typeof AcknowledgeCallerSettlementSchema.request>;
export type AcknowledgeCallerSettlementResponse = z.infer<typeof AcknowledgeCallerSettlementSchema.response>;
