import type {
  AllocationScope,
  BoundedRecoveryEvidence,
  HostDatabase,
  HostTransaction,
  JobRunId,
  ProviderAllocationRef,
  WorkerProviderId,
  WorkerRuntimeConnection,
  WorkerRuntimeInputs,
} from '@makaio/contracts';
import type { CallContext, PartyRef } from '@makaio/core';
import type { AllocationScopeSetting } from './allocation-scope-source.js';
import type { WorkerProviderRegistry } from './provider-registry.js';

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
export type StartWorkerResult =
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

/** Host-owned order snapshot joined to its original token deadline in the same transaction. */
export interface CommittedWorkerOrder {
  readonly order: StartOrder;
  readonly orderDigest: string;
  readonly owner: PartyRef;
  /** A redeemed run stays open until its result window closes. */
  readonly state: 'ordered' | 'redeemed' | 'closed';
  readonly runtimeInputs: WorkerRuntimeInputs;
  readonly preserveWorkspace?: boolean;
  readonly continues?: ProviderAllocationRef;
}

/** Adapter supplied by the host that owns the committed order and the volatile token. */
export interface WorkerOrderSource {
  /**
   * Lock the run using the same serialization point as redeem, cancel and expiry.
   * Return a snapshot only when order and admission consumption committed together.
   * Keep closed orders readable while their dispatches may still be supervised.
   * @param tx - The shared host transaction.
   * @param jobRunId - Order to lock and read.
   */
  lockOrder(tx: HostTransaction, jobRunId: JobRunId): Promise<CommittedWorkerOrder | undefined>;
  /**
   * Check local start material availability without reading its plaintext.
   * @param order - Locked order awaiting a start claim.
   */
  hasStartToken(order: CommittedWorkerOrder): boolean;
  /**
   * Read the original token after the unique insert has selected its winner.
   * @param order - Snapshot authenticated and locked in the host transaction.
   */
  readStartToken(order: CommittedWorkerOrder): string | undefined;
}

/** Host composition for the start port and its supervision operations. */
export interface WorkerStartOptions {
  readonly database: HostDatabase;
  readonly source: WorkerOrderSource;
  readonly providers: WorkerProviderRegistry;
  readonly scopeSetting: AllocationScopeSetting;
  /** Refreshed host connection values for the initial provider operation. */
  readonly connection: () => WorkerRuntimeConnection;
  /** Independent lifetime of provider operations, owned by the host. */
  readonly operationSignal: AbortSignal;
  /** Distinguishes actual process incarnations and is shared by ports in one host. */
  readonly processIncarnation: string;
}
