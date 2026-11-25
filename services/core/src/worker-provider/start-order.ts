import type {
  HostDatabase,
  HostTransaction,
  JobRunId,
  ProviderAllocationRef,
  WorkerRuntimeConnection,
  WorkerRuntimeInputs,
} from '@makaio/contracts';
import type { StartOrder, StartWorkerResult } from '@makaio/contracts/capabilities';
import type { PartyRef } from '@makaio/core';
import type { AllocationScopeSetting } from './allocation-scope-source.js';
import type { LocalWorkerControl } from './local-worker-control.js';
import type { WorkerProviderRegistry } from './provider-registry.js';

export type { StartOrder, StartWorkerResult } from '@makaio/contracts/capabilities';

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

/** Host-owned drain for work that can outlive the caller's wait. */
export interface ProvisionDrain {
  /** Aborted before the host stops accepting returned allocations into its registry. */
  readonly closed: AbortSignal;
  /**
   * Retain start work through outcome recording and handle handoff.
   * @param handoff - Settles once no unsent claim needs storage protection.
   * @param work - The complete start operation.
   */
  track(handoff: Promise<unknown>, work: Promise<StartWorkerResult>): void;
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
  readonly provisionDrain?: ProvisionDrain;
  /** Aborted when the host stops waiting for local teardown and releases storage. */
  readonly localCleanupSignal?: AbortSignal;
  /** Distinguishes actual process incarnations and is shared by ports in one host. */
  readonly processIncarnation: string;
  /** Live controls owned by this host incarnation. */
  readonly handles: Map<JobRunId, LocalWorkerControl>;
}
