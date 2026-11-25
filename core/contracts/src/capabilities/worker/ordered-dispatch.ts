import type { CallContext } from '@makaio/core';
import type { HostTransaction } from '../../host-database/host-database.js';
import type { JobRunId } from '../../workflow/identifiers.js';
import type { AllocationScope } from './allocation-scope.js';
import type { WorkerProviderId } from './provider-id.js';
import type { BoundedRecoveryEvidence, ProviderAllocationRef } from './types.js';

/** Bounded attach diagnostic suitable for an order ledger. */
export interface WorkerAttachFailure {
  readonly observedAt: string;
  readonly reason: 'attach-failed';
}

/** Immutable public binding from a committed order. */
export type StartOrder = Readonly<
  {
    jobRunId: JobRunId;
    workerProviderId: WorkerProviderId;
    bootstrapDeadlineAt: string;
  } & (
    | { allocationLifetime: 'provider-managed'; allocationScope: AllocationScope }
    | { allocationLifetime: 'provisioner-process-bound'; allocationScope?: never }
  )
>;

/** Infrastructure result of starting or observing the same order. */
export type StartWorkerResult = (
  | { kind: 'allocated'; allocationRef: ProviderAllocationRef }
  | { kind: 'confirmed-absent'; evidence: BoundedRecoveryEvidence }
  | { kind: 'unknown'; reason: 'dispatch-unresolved' | 'observation-unavailable' | 'allocation-conflict' }
  | {
      kind: 'refused';
      reason:
        | 'not-committed'
        | 'binding-mismatch'
        | 'run-closed'
        | 'bootstrap-expired'
        | 'provider-unavailable'
        | 'allocation-scope-blocked'
        | 'start-material-unavailable';
    }
) & {
  /** A safe diagnostic to persist, or null when a subsequent attach succeeded. */
  readonly lastAttachFailure?: WorkerAttachFailure | null;
  /** An unassigned discovery leaves a cleanup obligation open. */
  readonly cleanupRequired?: true;
};

/**
 * Start an ordered worker or observe the durable claim.
 * @param call - Authenticated in-process order owner.
 * @param order - Binding from the committed order.
 * @param signal - Cancels the caller's wait.
 * @throws {@link TypeError} If a process-bound provider returns an allocation without a terminate method.
 */
export type StartOrderedWorker = (
  call: CallContext,
  order: StartOrder,
  signal: AbortSignal,
) => Promise<StartWorkerResult>;

/** Requirements supplied by the host verifier for this bootstrap presentation. */
export type StartValueVisibility =
  | { readonly kind: 'allocation-only' }
  | {
      readonly kind: 'externally-visible';
      /** Verify the evidence for this exact allocation and return the evidence expiry. */
      readonly verifyPlatform: (allocationRef: ProviderAllocationRef) => Promise<string | undefined>;
    };

/** Conditional binding to invoke in the same transaction as token redemption. */
export interface PreparedAllocationBinding {
  readonly allocationRef: ProviderAllocationRef;
  /** Throws on stale/conflicting evidence so the containing redemption must roll back. */
  readonly bind: (tx: HostTransaction) => Promise<void>;
}

/** In-process access to the host's committed worker dispatch. */
export interface WorkerDispatchCapability {
  readonly startOrderedWorker: StartOrderedWorker;
  /**
   * Revisit a claimed dispatch, including an outstanding duty after run end.
   * @param call - Authenticated order owner.
   * @param jobRunId - Durable dispatch to revisit.
   * @param signal - Cancels the caller's wait.
   */
  superviseOrderedWorker(call: CallContext, jobRunId: JobRunId, signal: AbortSignal): Promise<StartWorkerResult>;
  /**
   * Verify the allocation before the host's separate redemption transaction.
   * @param call - Authenticated order owner.
   * @param jobRunId - Run from the host's bootstrap verification.
   * @param visibility - Host-selected platform verification policy.
   */
  prepareAllocationBinding(
    call: CallContext,
    jobRunId: JobRunId,
    visibility: StartValueVisibility,
  ): Promise<PreparedAllocationBinding | undefined>;
}
