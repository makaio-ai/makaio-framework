import type {
  AllocationInspection,
  AllocationListingRequest,
  AllocationObservationPage,
  AllocationScope,
  AllocationTermination,
  BoundedRecoveryEvidence,
  IsolationLevel,
  MaxRuntimeAssurance,
  ProviderAllocationRef,
  WorkerCapabilities,
  WorkerHandle,
  WorkerProviderId,
  WorkerRuntimeConnection,
} from '../../capabilities/index.js';
import type { JobRunId } from '../../workflow/index.js';
import type { WorkerRuntimeInputs } from '../../worker/index.js';
import type { CallContext, ContributionName } from '@makaio/core';

/**
 * Frozen provider identity and search boundary shared by dispatch and supervision.
 * The host wall clock records the boundary before provisioning. Providers widen
 * the search for clock skew as specified by {@link AllocationListingRequest}.
 */
export type DispatchBinding = Readonly<
  {
    jobRunId: JobRunId;
    providerId: WorkerProviderId;
    provisioningStartedAt: string;
  } & (
    | { allocationLifetime: 'provider-managed'; allocationScope: AllocationScope }
    | { allocationLifetime: 'provisioner-process-bound'; processIncarnation: string }
  )
>;

/** Start values are available only to the transaction winner. */
export interface OrderedProvisionRequest {
  readonly binding: DispatchBinding;
  readonly bootstrapDeadlineAt: string;
  readonly runtimeInputs: WorkerRuntimeInputs;
  readonly preserveWorkspace?: boolean;
  readonly continues?: ProviderAllocationRef;
  readonly oneTimeToken: string;
  readonly connection: WorkerRuntimeConnection;
}

/**
 * Accepted allocation, or definitive rejection before a send could take effect.
 * An accepted outcome returns only the reference and handle for the allocation created by that invocation.
 */
export type OrderedProvisionOutcome =
  | { kind: 'allocated'; allocationRef: ProviderAllocationRef; handle: WorkerHandle }
  | { kind: 'confirmed-absent'; evidence: BoundedRecoveryEvidence };

/** A provider-side guarantee that a live reference is the unique allocation for its binding. */
export interface UniqueLiveAllocation {
  readonly allocationRef: ProviderAllocationRef;
  readonly expiresAt: string;
}

/** The provider guarantees that no pending or future send for the binding can create another allocation. */
export interface SealedAllocationSet {
  readonly allocations: readonly ProviderAllocationRef[];
  readonly evidence: BoundedRecoveryEvidence;
}

/** Positive observation and cleanup operations for managed allocations. */
export interface OrderedWorkerRecovery {
  listAllocations(
    call: CallContext,
    request: AllocationListingRequest,
    signal: AbortSignal,
  ): Promise<AllocationObservationPage>;
  attach(
    call: CallContext,
    binding: DispatchBinding,
    ref: ProviderAllocationRef,
    signal: AbortSignal,
  ): Promise<WorkerHandle>;
  /**
   * This version of the ordered dispatch port compares allocation references
   * exactly and treats a refined reference as a conflict. The port does not accept
   * reference refinements in this version. This is a known deviation from the
   * worker capability contract, which allows a refined reference. Providers that
   * refine references are not yet supported by this port. Support for accepting
   * refinements will follow in a separate change.
   * @param call - Authorized supervision caller.
   * @param binding - Frozen dispatch identity.
   * @param ref - Exact allocation reference to inspect.
   * @param signal - Provider operation lifetime.
   */
  inspect(
    call: CallContext,
    binding: DispatchBinding,
    ref: ProviderAllocationRef,
    signal: AbortSignal,
  ): Promise<AllocationInspection>;
  /**
   * Repeat-safe: the host may call this more than once for the same reference,
   * for example when the sender and recovery both end a late allocation.
   * Repeating termination after a confirmed end returns `ended` with its
   * evidence again. See {@link AllocationTermination} for when a provider
   * rejects.
   * @param call - Authorized supervision caller.
   * @param binding - Frozen dispatch identity.
   * @param ref - Exact allocation reference to terminate.
   * @param signal - Provider operation lifetime.
   */
  terminateAllocation(
    call: CallContext,
    binding: DispatchBinding,
    ref: ProviderAllocationRef,
    signal: AbortSignal,
  ): Promise<AllocationTermination>;
  /** Independent of listing completeness. A listing alone cannot prove uniqueness. */
  proveUniqueLive?(
    call: CallContext,
    binding: DispatchBinding,
    ref: ProviderAllocationRef,
    signal: AbortSignal,
  ): Promise<UniqueLiveAllocation | undefined>;
  /**
   * Return a final set only when late sends and overdue creation are both fenced.
   * After the bootstrap deadline the caller may have no evidence that the sender ever ran or stopped.
   * @param call - Authorized supervision caller.
   * @param binding - Frozen scope, provider, run and search boundary.
   * @param signal - Provider operation lifetime.
   */
  proveSealed?(
    call: CallContext,
    binding: DispatchBinding,
    signal: AbortSignal,
  ): Promise<SealedAllocationSet | undefined>;
}

/** Validated provider contribution for the ordered start path. */
export type OrderedWorkerProvider = Readonly<
  {
    kind: ContributionName;
    id: WorkerProviderId;
    /** Whether any bootstrap start value can be read outside the allocation. */
    startValuesVisibility: 'allocation-only' | 'externally-visible';
    capabilities: WorkerCapabilities & { maxRuntimeMs: number; stepIsolation: IsolationLevel };
    assureMaxRuntime(call: CallContext, signal: AbortSignal): Promise<MaxRuntimeAssurance>;
    /** Sends at most once. Once this promise settles, no future send may originate from it. */
    provision(
      call: CallContext,
      request: OrderedProvisionRequest,
      signal: AbortSignal,
    ): Promise<OrderedProvisionOutcome>;
  } & (
    | { allocationLifetime: 'provider-managed'; recovery: OrderedWorkerRecovery }
    | {
        /**
         * The provider must tie the worker's lifetime to the host process.
         * After a host crash, later process incarnations cannot control those allocations.
         * Closing cleanup obligations for allocations no longer controllable requires separate reconciliation.
         */
        allocationLifetime: 'provisioner-process-bound';
        recovery?: never;
        /** A live allocation already registered in the bound process incarnation. */
        proveLocalLive(
          call: CallContext,
          binding: Extract<DispatchBinding, { allocationLifetime: 'provisioner-process-bound' }>,
          signal: AbortSignal,
        ): Promise<UniqueLiveAllocation | undefined>;
      }
  )
>;
