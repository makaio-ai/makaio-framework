import type {
  HostDatabase,
  HostTransaction,
  JobRunId,
  JsonValue,
  ProviderAllocationRef,
  WorkerRuntimeConnection,
  WorkerRuntimeInputs,
} from '@makaio/contracts';
import type { StartOrder, StartWorkerResult } from '@makaio/contracts/capabilities';
import type { ConnectionExchangeAccepted } from '@makaio/contracts/boundary';
import type { PartyRef } from '@makaio/core';
import type { AllocationObservationSignal } from './allocation-observation-signal.js';
import type { AllocationScopeSetting } from './allocation-scope-source.js';
import type { LocalWorkerControl } from './local-worker-control.js';
import type { WorkerProviderRegistry } from './provider-registry.js';

export type { StartOrder, StartWorkerResult } from '@makaio/contracts/capabilities';

/** Durable result stored on the run by its owner. */
export interface StoredWorkerRedemption {
  /**
   * Purpose-tagged digest of the runtime credential.
   *
   * The SHA-256 input is the UTF-8 bytes of the purpose (without the colon),
   * one NUL byte (0x00), and the UTF-8 bytes of the credential value, in that
   * order. The stored string is the purpose, a colon, and the lowercase hex digest.
   *
   * Purpose `worker-runtime-v1` and value `example input` give hex digest
   * `f4ea92a027441ce8c22d2a7c383832b8175ac0eac56c808bd435f5ea07c3523d`
   * and stored string
   * `worker-runtime-v1:f4ea92a027441ce8c22d2a7c383832b8175ac0eac56c808bd435f5ea07c3523d`.
   */
  readonly runtimeDigest: string;
  readonly redeemedAt: string;
  readonly requiresPlatformProof: boolean;
  readonly accepted: ConnectionExchangeAccepted & {
    readonly expiresAt: string;
    readonly revocationKey: string;
  };
}

/** Redemption fields and storage operation belonging to the locked owner row. */
export interface LockedWorkerRedemption {
  /** Active acceptance generation; checked again when committing prepared work. */
  readonly generation: string;
  /**
   * Bootstrap credential digest for this run and provider.
   *
   * The SHA-256 input is the UTF-8 bytes of the purpose (without the colon),
   * one NUL byte (0x00), and the UTF-8 bytes of the credential value, in that
   * order. The stored string is the purpose, a colon, and the lowercase hex digest.
   *
   * Purpose `worker-bootstrap-v1` and value `example input` give hex digest
   * `e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4`
   * and stored string
   * `worker-bootstrap-v1:e065986136506eb4daabc992e5f19bb0df27afe327fcb74b4aab82b169e563f4`.
   */
  readonly tokenDigest: string;
  readonly tokenRevoked: boolean;
  /** Current issuer standing for first use. */
  readonly issuerActive: boolean;
  readonly maxRuntimeMs: number;
  readonly cancellationWindowMs: number;
  /** Credential-free exchange response pinned at booking. */
  readonly payload: JsonValue;
  readonly stored?: StoredWorkerRedemption;
  /**
   * Conditionally consume the token and persist the identity and reply on the
   * ordered row for this generation. Only repository queries may run here.
   * @param tx - The transaction holding this row's lock.
   * @param result - Identity digest, policy and reply to persist.
   * @returns The persisted result, or undefined if the row failed the update condition.
   */
  accept(tx: HostTransaction, result: StoredWorkerRedemption): Promise<StoredWorkerRedemption | undefined>;
}

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
  /**
   * Present throughout the lifetime of a booking that requires atomic redemption,
   * including after revocation or closure. This selects the only path allowed to
   * assign the allocation to the run.
   */
  readonly redemption?: LockedWorkerRedemption;
}

/** Credential digests for an advisory read before acquiring the owner lock. */
export interface WorkerRedemptionCredentials {
  readonly tokenDigest: string;
  readonly runtimeDigest?: string;
}

interface WorkerOrderMaterialSource<Order extends CommittedWorkerOrder = CommittedWorkerOrder> {
  /**
   * Lock the run using the same serialization point as redeem, cancel and expiry.
   * Return a snapshot only when order and admission consumption committed together.
   * Loading the locked snapshot of an atomic redemption booking must leave storage unchanged.
   * Keep closed orders readable while their dispatches may still be supervised.
   * @param tx - The shared host transaction.
   * @param jobRunId - Order to lock and read.
   */
  lockOrder(tx: HostTransaction, jobRunId: JobRunId): Promise<Order | undefined>;
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

/** Owner whose bookings continue to use separate allocation binding. */
export interface SeparateBindingWorkerOrderSource
  extends WorkerOrderMaterialSource<CommittedWorkerOrder & { readonly redemption?: never }> {
  readonly readRedemptionCredentials?: never;
}

/** Owner that can book orders for atomic redemption. */
export interface AtomicRedemptionWorkerOrderSource extends WorkerOrderMaterialSource {
  /**
   * Read booked digests without acquiring a row lock or starting a write
   * transaction. This screens presentations before the authoritative check
   * through `lockOrder` and is mandatory for an owner offering atomic redemption.
   * @param jobRunId - Run whose credential digests are requested.
   * @returns The digests from the owner row for an atomic redemption booking.
   */
  readRedemptionCredentials(jobRunId: JobRunId): Promise<WorkerRedemptionCredentials | undefined>;
}

/** Adapter supplied by the host that owns the committed order and the volatile token. */
export type WorkerOrderSource = SeparateBindingWorkerOrderSource | AtomicRedemptionWorkerOrderSource;

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
  /** Direct wakeups shared by dispatch writers and redemption in this host. */
  readonly allocationObservation: AllocationObservationSignal;
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
