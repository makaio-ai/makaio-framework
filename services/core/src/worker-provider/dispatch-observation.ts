import type { WorkerAttachFailure } from '@makaio/contracts/capabilities';
import {
  ALLOCATION_LISTING_MAX_LIMIT,
  AllocationInspectionSchema,
  AllocationObservationSchema,
  AllocationObservationPageSchema,
  BoundedRecoveryEvidenceSchema,
  ProviderAllocationRefSchema,
  type AllocationObservation,
  type AllocationListingRequest,
  type BoundedRecoveryEvidence,
  type ProviderAllocationRef,
  type WorkerHandle,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { abortableWait } from '@makaio/utils';
import { z } from 'zod';
import { correlateAllocation } from './allocation-correlation.js';
import { hasOpenDeadline } from './start-claim.js';
import { mergeCandidates, sameReference, type DispatchClaim } from './dispatch-store.js';
import type { DispatchBinding, OrderedWorkerRecovery } from '@makaio/contracts/extension';

export type ManagedDispatch = Extract<DispatchBinding, { allocationLifetime: 'provider-managed' }>;

const [continuedPage, finalPage] = AllocationObservationPageSchema.options;
const observations = z.array(AllocationObservationSchema.optional().catch(undefined)).max(ALLOCATION_LISTING_MAX_LIMIT);
const ManagedPageSchema = z.union([continuedPage.extend({ observations }), finalPage.extend({ observations })]);

/** Independent facts from a scoped listing and an optional provider-side send fence. */
export interface ManagedObservation {
  readonly observedPage: boolean;
  readonly foreignDiscovery: boolean;
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
  let foreignDiscovery = false;
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
    const matches = page.observations.filter(
      (item): item is AllocationObservation => item !== undefined && matchesBinding(item, binding),
    );
    const foreignOnPage = matches.length !== page.observations.length;
    foreignDiscovery ||= foreignOnPage;
    candidates.push(...matches.map((item) => item.allocationRef));
    if ('completeness' in page) {
      if (cursor === undefined && !foreignOnPage) {
        const result = correlateAllocation(
          { jobRunId: binding.jobRunId, providerId: binding.providerId, scope: binding.allocationScope },
          { providerId: binding.providerId, request, page: { ...page, observations: matches } },
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
  return {
    observedPage,
    foreignDiscovery,
    firstPageCandidate,
    candidates: mergeCandidates(candidates, seal?.refs ?? []),
    seal,
  };
}

/**
 * Validate the page envelope and retain unvalidated entries as unattributed discoveries.
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
    return ManagedPageSchema.parse(await recovery.listAllocations(call, request, signal));
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
 * Identify a unique allocation from a durable binding, a sender reference or a complete scoped discovery.
 * @param claim - Claim containing any binding already established.
 * @param observation - Latest scoped observation.
 * @param candidates - Combined durable and observed references.
 * @param useSenderReference - Whether atomic redemption may use the reference recorded by the sender.
 * @returns The correlated reference, if unique.
 */
export function trustedObservationReference(
  claim: DispatchClaim,
  observation: ManagedObservation,
  candidates: readonly ProviderAllocationRef[],
  useSenderReference = false,
): ProviderAllocationRef | undefined {
  if (observation.foreignDiscovery || candidates.length !== 1) return undefined;
  return (
    claim.boundAllocation ?? (useSenderReference ? claim.senderReference : undefined) ?? observation.firstPageCandidate
  );
}

/** Attach status from this pass and, when independently proven, its liveness deadline. */
export interface AllocationObservationProof {
  readonly liveThrough?: number;
  readonly lastAttachFailure?: WorkerAttachFailure | null;
}

/**
 * Attach to an identified allocation and inspect it. Local disposal does not change its state.
 * @param call - Authorized observer.
 * @param recovery - Recovery operations for the bound provider.
 * @param claim - Current durable dispatch claim.
 * @param ref - Identified allocation.
 * @param signal - Host operation lifetime.
 * @returns Attach status and whether inspection confirmed liveness.
 */
async function attachAndInspect(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  claim: DispatchClaim,
  ref: ProviderAllocationRef,
  signal: AbortSignal,
): Promise<{ live: boolean; lastAttachFailure: WorkerAttachFailure | null }> {
  let handle: WorkerHandle;
  if (signal.aborted) return { live: false, lastAttachFailure: null };
  try {
    handle = await recovery.attach(call, claim.binding, ref, signal);
  } catch {
    return { live: false, lastAttachFailure: { observedAt: new Date().toISOString(), reason: 'attach-failed' } };
  }
  try {
    // A provider may return an attached handle after it has been canceled.
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return recovery.inspect(call, claim.binding, ref, signal);
    });
    const inspection = AllocationInspectionSchema.parse(await abortableWait(pending, signal));
    return {
      live:
        (inspection.state === 'running' || inspection.state === 'ready') &&
        sameReference(inspection.allocationRef, ref),
      lastAttachFailure: null,
    };
  } catch {
    return { live: false, lastAttachFailure: null };
  } finally {
    try {
      await handle.release();
    } catch {
      // Disposing the local handle cannot change the inspection result.
    }
  }
}

/**
 * Inspect an identified allocation, obtaining independent uniqueness evidence before a new binding.
 * @param call - Current observation or redemption call.
 * @param recovery - Bound recovery operations.
 * @param claim - Current dispatch claim.
 * @param ref - Identified allocation reference.
 * @param signal - Provider operation lifetime.
 * @param requireProof - Whether liveness must authorize a new binding or redemption.
 * @returns Attach status and any independently proven liveness deadline.
 */
export async function observeLiveAllocation(
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  claim: DispatchClaim,
  ref: ProviderAllocationRef,
  signal: AbortSignal,
  requireProof: boolean,
): Promise<AllocationObservationProof> {
  try {
    const proof = requireProof ? await recovery.proveUniqueLive?.(call, claim.binding, ref, signal) : undefined;
    if (requireProof && (proof === undefined || !sameReference(proof.allocationRef, ref))) return {};
    const { live, lastAttachFailure } = await attachAndInspect(call, recovery, claim, ref, signal);
    const liveThrough =
      live && proof !== undefined && hasOpenDeadline(proof.expiresAt) ? Date.parse(proof.expiresAt) : undefined;
    return { liveThrough, lastAttachFailure };
  } catch {
    return {};
  }
}
