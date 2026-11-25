import type { PreparedAllocationBinding, StartValueVisibility } from '@makaio/contracts/capabilities';
import { getHostTransactionQueryContext } from '@makaio/storage-drizzle';
import type { JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import {
  observeManaged,
  parseReference,
  observeLiveAllocation,
  trustedObservationReference,
} from './dispatch-observation.js';
import { type DispatchClaim, mergeCandidates, sameReference, updateDispatch } from './dispatch-store.js';
import { recordObservation } from './dispatch-supervision.js';
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

/**
 * Prove that only the identified allocation can redeem for this claim.
 * @param host - Worker start composition.
 * @param call - Trusted order-owner call.
 * @param claim - Durable dispatch claim.
 * @returns The exact verified reference and how long its proof is valid.
 */
async function findLiveReference(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
): Promise<LiveReference | undefined> {
  const { binding } = claim;
  const provider = host.providers.get(binding.providerId);
  if (
    binding.allocationLifetime === 'provisioner-process-bound' &&
    binding.processIncarnation === host.processIncarnation &&
    provider?.allocationLifetime === 'provisioner-process-bound'
  ) {
    const proof = await provider.proveLocalLive(call, binding, host.operationSignal);
    if (proof === undefined || !hasOpenDeadline(proof.expiresAt)) return undefined;
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
  const observation = await observeManaged(call, provider.recovery, binding, host.operationSignal, false);
  if (observation.foreignDiscovery) return undefined;
  const recorded = await recordObservation(host, claim, observation, undefined);
  if (recorded === undefined || recorded.updated.settled !== null) return undefined;
  const ref = trustedObservationReference(recorded.updated, observation, recorded.updated.candidates);
  if (ref === undefined) return undefined;
  const { liveThrough } = await observeLiveAllocation(call, provider.recovery, claim, ref, host.operationSignal, true);
  return liveThrough === undefined
    ? undefined
    : { ref, liveThrough, requiresPlatform: provider.startValuesVisibility === 'externally-visible' };
}

/**
 * Prepare an allocation binding outside the short host redemption transaction.
 * The host separately verifies the bootstrap token, visibility classification and platform proof.
 * @param host - Worker start composition.
 * @param call - Trusted order-owner call used for provider observation.
 * @param jobRunId - Run from the trusted bootstrap verification.
 * @param visibility - Host-selected platform verification policy.
 * @returns A conditional binding, or undefined while verification is incomplete.
 */
export async function prepareAllocationBinding(
  host: WorkerStartOptions,
  call: CallContext,
  jobRunId: JobRunId,
  visibility: StartValueVisibility,
): Promise<PreparedAllocationBinding | undefined> {
  const current = await host.database.transaction((tx) => lockDispatch(tx, host, jobRunId));
  if (current === undefined || !ownsOrder(call, current.order) || !mayRedeem(current.order)) return undefined;
  const { claim } = current;
  if (claim.settled !== null) return undefined;
  const live = await findLiveReference(host, call, claim);
  if (live === undefined) return undefined;
  const { ref, liveThrough, requiresPlatform } = live;
  if (requiresPlatform && visibility.kind !== 'externally-visible') return undefined;
  const platformDeadline =
    visibility.kind === 'externally-visible' ? await visibility.verifyPlatform(structuredClone(ref)) : undefined;
  if (visibility.kind === 'externally-visible' && !hasOpenDeadline(platformDeadline ?? '')) return undefined;
  const platformThrough = platformDeadline === undefined ? liveThrough : Date.parse(platformDeadline);
  const validThrough = Math.min(platformThrough, liveThrough);
  if (!(validThrough > Date.now())) return undefined;
  return {
    allocationRef: structuredClone(ref),
    bind: async (tx) => {
      host.operationSignal.throwIfAborted();
      getHostTransactionQueryContext(host.database, tx);
      const locked = await lockDispatch(tx, host, jobRunId);
      const candidates = mergeCandidates(locked?.claim.candidates ?? [], [ref]);
      if (
        locked === undefined ||
        !mayRedeem(locked.order) ||
        locked.claim.orderDigest !== claim.orderDigest ||
        !(validThrough > Date.now()) ||
        locked.claim.settled !== null ||
        candidates.length !== 1 ||
        (locked.claim.boundAllocation !== null && !sameReference(locked.claim.boundAllocation, ref))
      ) {
        throw new Error('Allocation binding is no longer valid');
      }
      await updateDispatch(tx, locked.claim, { boundAllocation: ref, candidates });
    },
  };
}
