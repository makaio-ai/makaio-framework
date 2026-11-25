import {
  AllocationBindingRequiresRedemptionError,
  type PreparedAllocationBinding,
  type StartValueVisibility,
} from '@makaio/contracts/capabilities';
import { getHostTransactionQueryContext, markTransactionRollbackOnly } from '@makaio/storage-drizzle';
import type { HostTransaction, JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { deepFreeze } from '@makaio/utils';
import {
  observeManaged,
  parseReference,
  observeLiveAllocation,
  trustedObservationReference,
} from './dispatch-observation.js';
import { type DispatchClaim, mergeCandidates, sameReference, updateDispatch } from './dispatch-store.js';
import { hasOpenDeadline, lockDispatch, ownsOrder } from './start-claim.js';
import type { CommittedWorkerOrder, WorkerStartOptions } from './start-order.js';

/**
 * Whether the authoritative first-redemption window is still open.
 * @param order - Locked order and deadline read from the original token row.
 * @returns Whether first redemption is still allowed.
 */
function mayRedeem(order: CommittedWorkerOrder): boolean {
  return order.state === 'ordered' && hasOpenDeadline(order.order.bootstrapDeadlineAt);
}

/** A verified live allocation and the deadline of its proof. */
interface LiveReference {
  readonly ref: ProviderAllocationRef;
  readonly liveThrough: number;
  readonly requiresPlatform: boolean;
}

/** Proof prepared outside the transaction for one exact dispatch. */
export interface PreparedDispatchProof {
  readonly ref: ProviderAllocationRef;
  readonly validThrough: number;
  readonly platformThrough?: number;
  readonly orderDigest: string;
}

/** Correlation is pending while more evidence can arrive, or uncorrelated once the sender cannot help. */
export type UnresolvedDispatchCorrelation = 'pending' | 'uncorrelated';

/** Proof policy selected by the host when preparing a binding. */
interface DispatchProofOptions {
  readonly signal: AbortSignal;
  readonly useSenderReference: boolean;
}

/**
 * Prove that only the identified allocation can redeem for this claim.
 * @param host - Worker start composition.
 * @param call - Authorized provider observation call.
 * @param claim - Durable dispatch claim.
 * @param options - Provider operation lifetime and reference policy.
 * @returns The verified reference, pending correlation, or rejection.
 */
async function findLiveReference(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  options: DispatchProofOptions,
): Promise<LiveReference | UnresolvedDispatchCorrelation | undefined> {
  const { binding } = claim;
  const provider = host.providers.get(binding.providerId);
  if (
    binding.allocationLifetime === 'provisioner-process-bound' &&
    binding.processIncarnation === host.processIncarnation &&
    provider?.allocationLifetime === 'provisioner-process-bound'
  ) {
    const proof = await provider.proveLocalLive(call, binding, options.signal);
    if (proof === undefined) return 'uncorrelated';
    if (!hasOpenDeadline(proof.expiresAt)) return undefined;
    const ref = parseReference(binding.providerId, proof.allocationRef);
    return ref === undefined
      ? undefined
      : {
          ref,
          liveThrough: Date.parse(proof.expiresAt),
          requiresPlatform: provider.startValuesVisibility === 'externally-visible',
        };
  }
  if (binding.allocationLifetime !== 'provider-managed' || provider?.allocationLifetime !== 'provider-managed')
    return undefined;
  const observation = await observeManaged(call, provider.recovery, binding, options.signal, false);
  options.signal.throwIfAborted();
  const candidates = mergeCandidates(claim.candidates, observation.candidates);
  const ref = trustedObservationReference(claim, observation, candidates, options.useSenderReference);
  if (ref === undefined) {
    // An empty listing may still gain an independent supervision observation after the sender settles.
    return observation.observedPage && !observation.foreignDiscovery && candidates.length === 0
      ? 'pending'
      : 'uncorrelated';
  }
  const { liveThrough } = await observeLiveAllocation(call, provider.recovery, claim, ref, options.signal, true);
  return liveThrough === undefined
    ? undefined
    : { ref, liveThrough, requiresPlatform: provider.startValuesVisibility === 'externally-visible' };
}

/**
 * Collect allocation and platform proof outside the redemption transaction.
 * Preparation performs no writes. Durable observations belong to supervision
 * and are recorded under its authority independently of the exchange outcome.
 * @param host - Worker start composition.
 * @param call - Trusted call used for provider observation.
 * @param claim - Dispatch authenticated against its locked order.
 * @param visibility - Host-selected platform verification policy.
 * @param options - Provider operation lifetime and reference policy.
 * @returns Proof for a conditional bind, pending correlation, or rejection.
 */
export async function prepareDispatchProof(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  visibility: StartValueVisibility,
  options: DispatchProofOptions = { signal: host.operationSignal, useSenderReference: false },
): Promise<PreparedDispatchProof | UnresolvedDispatchCorrelation | undefined> {
  const snapshot = deepFreeze(structuredClone(claim));
  if (snapshot.settled !== null) return undefined;
  const policy = Object.freeze({ ...visibility });
  const proofOptions = Object.freeze({ ...options });
  proofOptions.signal.throwIfAborted();
  const live = await findLiveReference(host, call, snapshot, proofOptions);
  proofOptions.signal.throwIfAborted();
  // An open sender can still commit provenance that an incomplete observation could not establish.
  if (live === 'uncorrelated' && !snapshot.sendSettled) return 'pending';
  if (typeof live !== 'object') return live;
  const { liveThrough, requiresPlatform } = live;
  const ref = deepFreeze(structuredClone(live.ref));
  if (requiresPlatform && policy.kind !== 'externally-visible') return undefined;
  const platformDeadline =
    policy.kind === 'externally-visible'
      ? await policy.verifyPlatform(structuredClone(ref), proofOptions.signal)
      : undefined;
  if (policy.kind === 'externally-visible' && !hasOpenDeadline(platformDeadline ?? '')) return undefined;
  const platformThrough = platformDeadline === undefined ? undefined : Date.parse(platformDeadline);
  const validThrough = Math.min(platformThrough ?? Infinity, liveThrough);
  if (!(validThrough > Date.now())) return undefined;
  return Object.freeze({ ref, validThrough, platformThrough, orderDigest: snapshot.orderDigest });
}

/**
 * Bind verified allocation in the already-locked run transaction.
 * @param tx - Transaction holding the owner row lock.
 * @param locked - Current owner order and dispatch.
 * @param proof - Proof collected before opening this transaction.
 * @returns Whether the allocation was bound.
 */
export async function bindDispatchProof(
  tx: HostTransaction,
  locked: Awaited<ReturnType<typeof lockDispatch>>,
  proof: PreparedDispatchProof,
): Promise<boolean> {
  const { ref, orderDigest, validThrough } = proof;
  const candidates = mergeCandidates(locked?.claim.candidates ?? [], [ref]);
  if (
    locked === undefined ||
    !mayRedeem(locked.order) ||
    locked.claim.orderDigest !== orderDigest ||
    !(validThrough > Date.now()) ||
    locked.claim.settled !== null ||
    candidates.length !== 1 ||
    (locked.claim.boundAllocation !== null && !sameReference(locked.claim.boundAllocation, ref))
  ) {
    return false;
  }
  await updateDispatch(tx, locked.claim, { boundAllocation: ref, candidates });
  return true;
}

/**
 * Prepare a binding for the in-process order owner.
 * @param host - Worker start composition.
 * @param call - Trusted order-owner call.
 * @param jobRunId - Run from the host's bootstrap verification.
 * @param visibility - Host-selected platform verification policy.
 * @returns A conditional binding, if available.
 */
export async function prepareAllocationBinding(
  host: WorkerStartOptions,
  call: CallContext,
  jobRunId: JobRunId,
  visibility: StartValueVisibility,
): Promise<PreparedAllocationBinding | undefined> {
  const policy = Object.freeze({ ...visibility });
  const current = await host.database.transaction((tx) => lockDispatch(tx, host, jobRunId));
  if (current === undefined || !ownsOrder(call, current.order)) return undefined;
  if (current.order.redemption !== undefined) throw new AllocationBindingRequiresRedemptionError();
  if (!mayRedeem(current.order)) return undefined;
  const proof = await prepareDispatchProof(host, call, current.claim, policy);
  if (typeof proof !== 'object') return undefined;
  return Object.freeze<PreparedAllocationBinding>({
    allocationRef: proof.ref,
    bind: async (tx) => {
      getHostTransactionQueryContext(host.database, tx);
      host.operationSignal.throwIfAborted();
      let refusal: Error | undefined;
      try {
        const locked = await lockDispatch(tx, host, jobRunId);
        if (locked === undefined || !ownsOrder(call, locked.order)) {
          refusal = new Error('Allocation binding is no longer valid');
        } else if (locked.order.redemption !== undefined) {
          refusal = new AllocationBindingRequiresRedemptionError();
        } else if (!(await bindDispatchProof(tx, locked, proof))) {
          refusal = new Error('Allocation binding is no longer valid');
        }
      } catch (error) {
        markTransactionRollbackOnly(tx, new Error('Allocation binding is no longer valid'));
        throw error;
      }
      if (refusal !== undefined) throw refusal;
    },
  });
}
