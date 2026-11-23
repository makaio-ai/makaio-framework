import { z } from 'zod';
import { BoundedRecoveryEvidenceSchema } from './types.js';

/** Evidence of which boundary enforces the provider's declared maximum runtime. */
export const MaxRuntimeAssuranceSchema = z.discriminatedUnion('boundary', [
  z.strictObject({ boundary: z.literal('platform'), evidence: BoundedRecoveryEvidenceSchema }),
  z.strictObject({ boundary: z.literal('provider-process'), evidence: BoundedRecoveryEvidenceSchema }),
]);

/**
 * Evidence for the boundary enforcing a worker's maximum runtime.
 * A provider-managed allocation always reports the platform boundary. A process-bound
 * provider may report its own process boundary when it enforces the limit there.
 */
export type MaxRuntimeAssurance = z.infer<typeof MaxRuntimeAssuranceSchema>;

/** Evidence of a confirmed allocation end or an outstanding termination request. */
export const AllocationTerminationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ended'), evidence: BoundedRecoveryEvidenceSchema }),
  z.strictObject({ state: z.literal('ending'), evidence: BoundedRecoveryEvidenceSchema }),
]);

/**
 * Evidence that a termination was requested or confirmed.
 * An `ending` result leaves the cleanup obligation open. Repeating termination
 * after a confirmed `ended` result returns `ended` again. A provider rejects if
 * it neither took a termination action nor has evidence of a confirmed end.
 */
export type AllocationTermination = z.infer<typeof AllocationTerminationSchema>;
