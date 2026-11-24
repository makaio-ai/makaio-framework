import { z } from 'zod';
import { JobRunIdSchema } from '../../workflow/identifiers.js';
import { AllocationStateSchema, BoundedRecoveryEvidenceSchema, ProviderAllocationRefSchema } from './types.js';
import { AllocationScopeValueSchema } from './allocation-scope.js';
import { WorkerProviderIdSchema } from './provider-id.js';

/** Default page size when listing worker allocations. */
export const ALLOCATION_LISTING_DEFAULT_LIMIT = 50;
/** Largest accepted page size; a larger `limit` is a schema error. */
export const ALLOCATION_LISTING_MAX_LIMIT = 500;

/** Request for one page of allocations in a confirmed {@link AllocationScope.value}. */
export const AllocationListingRequestSchema = z
  .object({
    allocationScope: AllocationScopeValueSchema,
    /** Restrict the listing to one job run (candidates of an ambiguous discovery). */
    jobRunId: JobRunIdSchema.optional(),
    /**
     * Inclusive search lower bound sampled on the host before provision.
     * Round the provider-side cutoff down to cover clock skew and timestamp precision.
     * If skew is unbounded, search by scope and identity without a time cutoff.
     */
    provisioningStartedAt: z.iso.datetime().optional(),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(ALLOCATION_LISTING_MAX_LIMIT).optional(),
  })
  .strict();
export type AllocationListingRequest = z.infer<typeof AllocationListingRequestSchema>;

/** One allocation positively attributed to this instance and scope. */
export const AllocationObservationSchema = z
  .object({
    allocationRef: ProviderAllocationRefSchema.extend({ providerId: WorkerProviderIdSchema }),
    jobRunId: JobRunIdSchema,
    state: AllocationStateSchema,
  })
  .strict();
export type AllocationObservation = z.infer<typeof AllocationObservationSchema>;

/** Completeness that could not be established: observations stand; neither absence nor uniqueness may be concluded. */
export const UnknownAllocationListingCompletenessSchema = z.strictObject({
  kind: z.literal('unknown'),
  evidence: BoundedRecoveryEvidenceSchema,
});

/** Completeness of a listing, stated on its last page only. */
export const AllocationListingCompletenessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete') }),
  UnknownAllocationListingCompletenessSchema,
]);
export type AllocationListingCompleteness = z.infer<typeof AllocationListingCompletenessSchema>;

const PageObservationsSchema = z.array(AllocationObservationSchema).max(ALLOCATION_LISTING_MAX_LIMIT);

/** One page: either more pages follow (`nextCursor`) or completeness is stated. */
export const AllocationObservationPageSchema = z.union([
  z.object({ observations: PageObservationsSchema, nextCursor: z.string().min(1) }).strict(),
  z.object({ observations: PageObservationsSchema, completeness: AllocationListingCompletenessSchema }).strict(),
]);
export type AllocationObservationPage = z.infer<typeof AllocationObservationPageSchema>;
