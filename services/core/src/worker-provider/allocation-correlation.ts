import {
  type AllocationListingRequest,
  type AllocationObservation,
  AllocationObservationPageSchema,
  type AllocationScope,
  type JobRunId,
  type ProviderAllocationRef,
  type WorkerProviderId,
} from '@makaio/contracts';
import { canonicalStringify } from '@makaio/utils';

/** Identity held by the caller for a provider-managed allocation. */
export interface AllocationCorrelationTarget {
  readonly jobRunId: JobRunId;
  readonly providerId: WorkerProviderId;
  readonly scope: AllocationScope;
  readonly allocationRef?: ProviderAllocationRef;
}

/** Evidence returned by one scoped provider listing call. */
export interface ScopedAllocationListing {
  readonly providerId: WorkerProviderId;
  readonly request: AllocationListingRequest;
  readonly page: unknown;
}

/** Positive correlation or insufficient evidence to identify the allocation. */
export type AllocationCorrelation =
  | { readonly kind: 'observed'; readonly observation: AllocationObservation }
  | { readonly kind: 'unknown' };

/**
 * Correlate a provider observation with a job run in the confirmed scope.
 *
 * A previously recorded reference can match on any page. Without a recorded
 * reference, only a complete single-page listing can establish uniqueness.
 * Empty listings and mismatched evidence leave correlation unknown. A match
 * conveys the reported infrastructure state, with cleanup tracked separately.
 * @param target - Job run and provider binding, with the recorded reference when available.
 * @param listing - Provider identity, originating request and returned page.
 * @returns A positively correlated observation, or unknown.
 */
export function correlateAllocation(
  target: AllocationCorrelationTarget,
  listing: ScopedAllocationListing,
): AllocationCorrelation {
  const { providerId, request } = listing;
  if (
    providerId !== target.providerId ||
    request.allocationScope !== target.scope.value ||
    request.jobRunId !== target.jobRunId
  ) {
    return { kind: 'unknown' };
  }

  const page = AllocationObservationPageSchema.safeParse(listing.page);
  if (
    !page.success ||
    page.data.observations.some(
      (observation) => observation.jobRunId !== target.jobRunId || observation.allocationRef.providerId !== providerId,
    )
  ) {
    return { kind: 'unknown' };
  }

  const { allocationRef } = target;
  const { observations } = page.data;
  if (allocationRef === undefined) {
    if (request.cursor !== undefined || !('completeness' in page.data) || page.data.completeness.kind !== 'complete') {
      return { kind: 'unknown' };
    }
    return correlateSingleObservation(observations);
  }

  const key = canonicalStringify(allocationRef);
  return correlateSingleObservation(
    observations.filter((observation) => canonicalStringify(observation.allocationRef) === key),
  );
}

/**
 * Establish correlation only when exactly one observation qualifies.
 * @param observations - Eligible observations in this listing.
 * @returns The single match or unknown when the evidence is inconclusive.
 */
function correlateSingleObservation(observations: readonly AllocationObservation[]): AllocationCorrelation {
  const [observation] = observations;
  return observation !== undefined && observations.length === 1
    ? { kind: 'observed', observation }
    : { kind: 'unknown' };
}
