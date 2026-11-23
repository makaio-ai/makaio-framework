import { ExtensionNameSchema } from '@makaio/core';
import { z } from 'zod';
import { AllocationScopeBlockReasonSchema, type AllocationScope } from './allocation-scope.js';
import { WorkerProviderIdSchema } from './provider-id.js';
import {
  ALLOCATION_LISTING_MAX_LIMIT,
  AllocationListingCompletenessSchema,
  AllocationObservationSchema,
} from './observation.js';

/**
 * One block: the activation of one contributing extension was refused because
 * its provider-managed instances have no confirmed scope.
 */
export const AllocationScopeBlockSchema = z
  .object({
    /** Name of the contributing extension whose activation was refused. */
    owner: ExtensionNameSchema,
    reason: AllocationScopeBlockReasonSchema,
    /** Provider ids of the refused set. */
    blockedProviderIds: z.array(WorkerProviderIdSchema).min(1),
    /**
     * Allocations observed under the operator's setting while the binding is
     * missing, flattened over all pages, at most {@link ALLOCATION_LISTING_MAX_LIMIT}.
     * Empty for every other reason: no scope value may be listed then.
     */
    observations: z.array(AllocationObservationSchema).max(ALLOCATION_LISTING_MAX_LIMIT),
    /** Completeness of `observations`; `unknown` also when the cap was reached or no observation was made. */
    completeness: AllocationListingCompletenessSchema,
  })
  .strict()
  .refine(({ reason, observations }) => reason === 'binding-missing' || observations.length === 0, {
    path: ['observations'],
    message: 'Only a missing binding permits allocation observations',
  })
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
