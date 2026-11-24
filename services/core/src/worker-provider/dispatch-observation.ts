import {
  AllocationInspectionSchema,
  AllocationObservationPageSchema,
  BoundedRecoveryEvidenceSchema,
  ProviderAllocationRefSchema,
  type AllocationObservation,
  type AllocationListingRequest,
  type BoundedRecoveryEvidence,
  type ProviderAllocationRef,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { correlateAllocation } from './allocation-correlation.js';
import { hasOpenDeadline } from './start-claim.js';
import { mergeCandidates, sameReference, type DispatchClaim } from './dispatch-store.js';
import type { DispatchBinding, OrderedWorkerRecovery } from './ordered-provider.js';

export type ManagedDispatch = Extract<DispatchBinding, { allocationLifetime: 'provider-managed' }>;

/** Independent facts from a scoped listing and an optional provider-side send fence. */
export interface ManagedObservation {
  readonly observedPage: boolean;
  readonly firstPageCandidate?: ProviderAllocationRef;
  readonly candidates: readonly ProviderAllocationRef[];
  readonly seal?: { readonly refs: readonly ProviderAllocationRef[]; readonly evidence: BoundedRecoveryEvidence };
}

/**
 * Validate a provider reference before recording or controlling it.
 * @param providerId - Stable instance that returned the reference.
 * @param candidate - Untrusted reference value.
 * @returns Validated reference owned by the instance, or undefined.
 */
export function parseReference(providerId: string, candidate: unknown): ProviderAllocationRef | undefined {
  const parsed = ProviderAllocationRefSchema.safeParse(candidate);
  return parsed.success && parsed.data.providerId === providerId ? parsed.data : undefined;
}

/**
 * Observe one or more pages. Valid positive matches survive incomplete coverage.
 * @param call - Current supervision call.
 * @param recovery - Recovery operations of the frozen provider instance.
 * @param binding - Durable dispatch identity.
 * @param signal - Independent provider operation lifecycle.
 * @param checkSeal - Whether to ask the provider for independent finality evidence.
 * @returns Positive candidates and evidence, if available.
 */
export async function observeManaged(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  binding: ManagedDispatch,
  signal: AbortSignal,
  checkSeal: boolean,
): Promise<ManagedObservation> {
  const candidates: ProviderAllocationRef[] = [];
  let observedPage = false;
  const seen = new Set<string>();
  let cursor: string | undefined;
  let firstPageCandidate: ProviderAllocationRef | undefined;
  do {
    const request: AllocationListingRequest = {
      allocationScope: binding.allocationScope.value,
      jobRunId: binding.jobRunId,
      provisioningStartedAt: binding.provisioningStartedAt,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = await readPage(call, recovery, request, signal);
    if (page === undefined) break;
    observedPage = true;
    const matches = page.observations.filter((item) => matchesBinding(item, binding));
    candidates.push(...matches.map((item) => item.allocationRef));
    if ('completeness' in page) {
      if (cursor === undefined) {
        const result = correlateAllocation(
          { jobRunId: binding.jobRunId, providerId: binding.providerId, scope: binding.allocationScope },
          { providerId: binding.providerId, request, page },
        );
        if (result.kind === 'observed') firstPageCandidate = result.observation.allocationRef;
      }
      break;
    }
    cursor = page.nextCursor;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  } while (!signal.aborted);
  const seal = checkSeal ? await readSeal(call, recovery, binding, signal) : undefined;
  return { observedPage, firstPageCandidate, candidates: mergeCandidates(candidates, seal?.refs ?? []), seal };
}

/**
 * Read and validate a page from the bound scope and provider.
 * @param call - Supervision call.
 * @param recovery - Bound recovery operations.
 * @param request - Bound listing request and provider continuation token.
 * @param signal - Provider operation lifetime.
 * @returns A validated page, or undefined when observation fails.
 */
async function readPage(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  request: AllocationListingRequest,
  signal: AbortSignal,
) {
  try {
    return AllocationObservationPageSchema.parse(await recovery.listAllocations(call, request, signal));
  } catch {
    return undefined;
  }
}

/**
 * Check the explicit correlation on an observation from the scoped provider call.
 * @param observation - Parsed observation.
 * @param binding - Expected provider instance and job run.
 * @returns Whether the observation belongs to the dispatch.
 */
function matchesBinding(observation: AllocationObservation, binding: ManagedDispatch): boolean {
  return observation.jobRunId === binding.jobRunId && observation.allocationRef.providerId === binding.providerId;
}

/**
 * Look for proof that pending or future sends cannot add any allocations.
 * @param call - Supervision call.
 * @param recovery - Bound recovery operations.
 * @param binding - Durable dispatch identity.
 * @param signal - Provider operation lifetime.
 * @returns A validated final set, or undefined while late creation remains possible.
 */
async function readSeal(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  binding: ManagedDispatch,
  signal: AbortSignal,
) {
  try {
    const seal = await recovery.proveSealed?.(call, binding, signal);
    if (seal === undefined) return undefined;
    const evidence = BoundedRecoveryEvidenceSchema.parse(seal.evidence);
    const refs = seal.allocations.map((ref) => parseReference(binding.providerId, ref));
    return refs.every((ref) => ref !== undefined) ? { refs, evidence } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check for an independently proven live, unique allocation.
 * @param call - Current observation or redemption call.
 * @param recovery - Bound recovery operations.
 * @param claim - Current dispatch claim.
 * @param candidates - Current durable and observed candidates.
 * @param ref - Previously bound reference or sole complete first-page match.
 * @param signal - Provider operation lifetime.
 * @returns Proof expiry in epoch milliseconds, or undefined.
 */
export async function proveUniqueLive(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  claim: DispatchClaim,
  candidates: readonly ProviderAllocationRef[],
  ref: ProviderAllocationRef | undefined,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (ref === undefined || candidates.length !== 1 || !sameReference(candidates[0] ?? ref, ref)) return undefined;
  try {
    const proof = await recovery.proveUniqueLive?.(call, claim.binding, ref, signal);
    if (proof === undefined || !sameReference(proof.allocationRef, ref)) return undefined;
    const handle = await recovery.attach(call, claim.binding, ref, signal);
    try {
      const inspection = AllocationInspectionSchema.parse(await recovery.inspect(call, claim.binding, ref, signal));
      const live = inspection.state === 'running' || inspection.state === 'ready';
      if (live && sameReference(inspection.allocationRef, ref) && hasOpenDeadline(proof.expiresAt))
        return Date.parse(proof.expiresAt);
    } finally {
      try {
        await handle.release();
      } catch {
        // Local disposal cannot invalidate an established live proof.
      }
    }
  } catch {
    return undefined;
  }
}
