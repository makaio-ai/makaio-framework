import { ExtensionNameSchema } from '@makaio/core';
import { z } from 'zod';
import { AllocationScopeBlockReasonSchema, type AllocationScope } from './allocation-scope.js';
import { WorkerProviderIdSchema } from './provider-id.js';
import {
  ALLOCATION_LISTING_MAX_LIMIT,
  AllocationListingCompletenessSchema,
  AllocationObservationSchema,
  UnknownAllocationListingCompletenessSchema,
} from './observation.js';

const ScopeBlockBaseSchema = z.strictObject({
  /** Contributing extension whose activation was refused. */
  owner: ExtensionNameSchema,
  /** Provider IDs in the refused set. */
  blockedProviderIds: z.array(WorkerProviderIdSchema).min(1),
});

/** A refused activation, with observations only when a missing binding permits listing. */
export const AllocationScopeBlockSchema = z
  .discriminatedUnion('reason', [
    ScopeBlockBaseSchema.extend({
      reason: z.literal('binding-missing'),
      /** Allocations across all pages, up to the listing cap. */
      observations: z.array(AllocationObservationSchema).max(ALLOCATION_LISTING_MAX_LIMIT),
      /** Unknown when the cap is reached or no observation was made. */
      completeness: AllocationListingCompletenessSchema,
    }).refine(
      ({ observations, completeness }) =>
        observations.length < ALLOCATION_LISTING_MAX_LIMIT || completeness.kind === 'unknown',
      { path: ['completeness'], message: 'Completeness is unknown when the observation cap is reached' },
    ),
    ScopeBlockBaseSchema.extend({
      reason: AllocationScopeBlockReasonSchema.exclude(['binding-missing']),
      /** Empty because this reason forbids listing. */
      observations: z.array(z.never()).max(0),
      /** No listing took place. */
      completeness: UnknownAllocationListingCompletenessSchema,
    }),
  ])
  .refine(
    ({ blockedProviderIds, observations }) => {
      const blocked = new Set(blockedProviderIds);
      return observations.every(({ allocationRef }) => blocked.has(allocationRef.providerId));
    },
    {
      path: ['observations'],
      message: 'Observations must belong to blocked providers',
    },
  );
export type AllocationScopeBlock = z.infer<typeof AllocationScopeBlockSchema>;

/** State of the scope: the confirmed scope once a binding exists, and one block per refused contributor. */
export interface AllocationScopeStatus {
  /**
   * The confirmed scope, defined once a stored binding exists. Only instances
   * of contributors that matched it are installed, so an instance returned by
   * `selectForProvisioning` can always be given this scope.
   */
  readonly scope: AllocationScope | undefined;
  /** One block per contributor whose activation was refused; empty when none was. */
  readonly blocks: readonly AllocationScopeBlock[];
}
