import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Attempt Lifecycle States
// ─────────────────────────────────────────────────────────────

/**
 * Lifecycle status of an execution attempt.
 *
 * - `pending`: attempt created but provider provisioning has not started.
 * - `provisioning`: a provider call is in flight but no allocation is recorded.
 * - `allocated`: a provider has accepted the attempt and recorded an allocation.
 * - `settled`: the attempt has a committed terminal outcome (accepted or failed).
 */
export type ExecutionAttemptStatus = 'pending' | 'provisioning' | 'allocated' | 'settled';

/**
 * How a settled attempt reached its terminal state.
 *
 * - `outcome`: a worker submitted a workflow result that was accepted.
 * - `infrastructure-failure`: the provider allocation terminated without
 *   an acknowledged worker outcome. The workflow run may be retried.
 * - `abandoned`: dispatch ended before allocation, including a provider
 *   provisioning failure recorded through {@link ExecutionAttemptRepository.recordProvisioningFailure}.
 *
 * `null` when the attempt has not yet settled.
 */
export type ExecutionAttemptSettlementKind = 'outcome' | 'abandoned' | 'infrastructure-failure' | null;

// ─────────────────────────────────────────────────────────────
// Attempt Records (JSON-safe, non-secret)
// ─────────────────────────────────────────────────────────────

/**
 * Durable record for one execution attempt.
 *
 * Produced by the injected {@link ExecutionAttemptRepository} and consumed by
 * the Authority service. All fields are JSON-safe and contain no secrets.
 */
export interface ExecutionAttemptRecord {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier this attempt belongs to. */
  readonly executionId: string;
  /** Current lifecycle status of the attempt. */
  readonly status: ExecutionAttemptStatus;
  /** Provider allocation reference, set after allocation recording. */
  readonly allocationRef: ProviderAllocationRef | null;
  /** ISO-8601 timestamp when the attempt was created. */
  readonly createdAt: string;
  /**
   * How this attempt reached its terminal state.
   *
   * `null` while the attempt is `pending`, `provisioning`, or `allocated`. Set to `'outcome'`
   * when a worker outcome is committed, or `'infrastructure-failure'` when
   * the provider allocation terminated without an acknowledged outcome, or
   * `'abandoned'` when dispatch ends before allocation or provisioning fails.
   */
  readonly settlementKind?: ExecutionAttemptSettlementKind;
  /**
   * Whether this attempt is eligible for bootstrap claims.
   *
   * Set to `true` when the attempt is allocated and a recovery-capable
   * provider is assigned. Cleared when the attempt settles or is replaced.
   */
  readonly claimable?: boolean;
  /**
   * ISO-8601 timestamp after which claim eligibility expires.
   *
   * `null` when claim eligibility has no expiry or the attempt is not claimable.
   * The host application owns expiry policy; the port stores the deadline.
   */
  readonly claimExpiresAt?: string | null;
}

/**
 * An allocated attempt that is eligible for recovery.
 *
 * Guarantees that `allocationRef` is non-null, status is `'allocated'`,
 * and the attempt has not settled. Used as the return type of
 * {@link ExecutionAttemptRepository.getRecoverableAttempts} to give
 * callers a narrowed type without runtime re-checks.
 */
export interface RecoverableAttemptRecord extends ExecutionAttemptRecord {
  /** Always `'allocated'` for recoverable attempts. */
  readonly status: 'allocated';
  /** Always non-null for recoverable attempts. */
  readonly allocationRef: ProviderAllocationRef;
  /** Always `true` for recoverable attempts. */
  readonly claimable: true;
  /** Always `null` for recoverable attempts (not yet settled). */
  readonly settlementKind: null;
}

// ─────────────────────────────────────────────────────────────
// Repository Input Shapes
// ─────────────────────────────────────────────────────────────

/**
 * Input for creating a new execution attempt.
 *
 * The Authority generates `executionAttemptId` before calling this method.
 */
export interface ExecutionAttemptCreate {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier. */
  readonly executionId: string;
}

/**
 * Input for committing a terminal outcome to an attempt.
 *
 * The repository makes the durable accept/duplicate/conflict/fence decision
 * and returns the canonical outcome for convergence.
 */
export interface ExecutionAttemptOutcomeCommit {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Terminal workflow result to commit. */
  readonly result: WorkflowRunResult;
}

/**
 * Input for a compare-and-set evolution of an allocation reference.
 *
 * Used when provider correlation updates the reference after initial
 * allocation (e.g. GitHub Actions run/job identity becomes known after
 * the initial `workflow_dispatch` returns only a dispatch timestamp).
 *
 * The repository must verify that `currentRef` matches the stored
 * allocation reference for the given attempt. If it does not match,
 * the evolution is rejected to prevent lost updates.
 */
export interface AllocationRefEvolution {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier (for active-attempt verification). */
  readonly executionId: string;
  /**
   * The allocation reference the caller believes is currently stored.
   *
   * Deep-equality comparison against the stored reference determines
   * whether the evolution is permitted.
   */
  readonly currentRef: ProviderAllocationRef;
  /** The new allocation reference to store if the CAS check passes. */
  readonly nextRef: ProviderAllocationRef;
}

/**
 * Decision returned by {@link ExecutionAttemptRepository.evolveAllocationRef}.
 *
 * - `evolved`: the reference was successfully updated.
 * - `stale`: `currentRef` does not match the stored reference (lost update).
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 * - `not-allocated`: the attempt has no allocation to evolve.
 */
export type AllocationRefEvolutionDecision =
  | { readonly kind: 'evolved' }
  | { readonly kind: 'stale'; readonly storedRef: ProviderAllocationRef }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-allocated' };

/**
 * Decision returned by
 * {@link ExecutionAttemptRepository.recordInfrastructureFailure}.
 *
 * - `recorded`: the failure was persisted and the attempt is now settled.
 * - `already-settled`: the attempt already has a terminal outcome or
 *   infrastructure failure recorded; this call is a no-op.
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 * - `not-allocated`: the attempt has no allocation — it cannot have an
 *   infrastructure failure without a provider resource.
 */
export type InfrastructureFailureDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-allocated' };

/** Durable decision for an attempt that failed before provider allocation. */
export type PendingAttemptAbandonmentDecision =
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'already-abandoned' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'allocated' }
  | { readonly kind: 'provisioning' }
  | { readonly kind: 'fenced' };

/**
 * Durable decision for claiming provider provisioning ownership.
 *
 * `started` alone authorizes a provider call. All other decisions deny a new
 * call because provisioning is already in progress, or the attempt is
 * allocated, terminal, or fenced.
 */
export type ProvisioningClaimDecision =
  | { readonly kind: 'started' }
  | { readonly kind: 'already-provisioning' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'already-settled'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'fenced' };

/**
 * Durable decision for recording an allocation after provider provisioning.
 *
 * `recorded` and `duplicate` confirm that the caller owns `allocationRef`.
 * Every other decision denies ownership and carries an existing reference when
 * one exists, preserving durable evidence for diagnostics and reconciliation.
 */
export type AllocationRecordingDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'duplicate'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'conflict'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'already-settled'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'fenced'; readonly allocationRef: ProviderAllocationRef | null };

/**
 * Durable decision for a provider failure before allocation recording.
 *
 * `recorded` terminalizes a provisioning attempt as `settled(abandoned)`.
 * It atomically competes with allocation recording; callers must preserve any
 * allocation that won instead of terminalizing it as a provisioning failure.
 * After allocation, providers must use {@link ExecutionAttemptRepository.recordInfrastructureFailure}
 * for confirmed terminal infrastructure evidence.
 */
export type ProvisioningFailureDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'already-settled'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'not-provisioning' }
  | { readonly kind: 'fenced' };

// ─────────────────────────────────────────────────────────────
// Repository Outcome Decisions
// ─────────────────────────────────────────────────────────────

/**
 * Durable outcome decision returned by {@link ExecutionAttemptRepository.commitOutcome}.
 *
 * - `accepted`: the outcome was committed as canonical for the first time.
 * - `duplicate`: an identical outcome was already committed; this is a replay.
 * - `conflict`: a different outcome was already committed for this attempt.
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 */
export type ExecutionAttemptOutcomeDecision =
  | { readonly kind: 'accepted'; readonly outcome: WorkflowRunResult }
  | { readonly kind: 'duplicate'; readonly outcome: WorkflowRunResult }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'fenced' };

// ─────────────────────────────────────────────────────────────
// Injected Port
// ─────────────────────────────────────────────────────────────

/**
 * Passive injected port for durable execution attempt persistence.
 *
 * The consuming host application owns the concrete implementation and all durable
 * accept/duplicate/conflict/fence decisions. Makaio's Authority service
 * calls through this port but never owns the underlying table or storage.
 *
 * Implementations must be idempotent for `createAttempt`, `beginProvisioning`, and `recordAllocation`
 * when called with the same identifiers. `commitOutcome` must return the
 * previously accepted outcome for exact replay (duplicate) and reject
 * conflicting outcomes.
 */
export interface ExecutionAttemptRepository {
  /**
   * Persist a new execution attempt record.
   *
   * Called by the Authority before dispatch. The Authority owns
   * `executionAttemptId` generation; the repository only persists.
   * @param input - Attempt identity to persist.
   * @returns The created attempt record.
   */
  createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord>;

  /**
   * Claim the durable provisioning phase immediately before a provider call.
   *
   * Only `pending` transitions to `provisioning`; a repeated call receives
   * `already-provisioning` and must await the existing attempt rather than
   * replaying provider provisioning. Allocated, settled, and fenced decisions
   * also deny a new call.
   * @param executionAttemptId - Attempt whose provider call is about to begin.
   * @param executionId - Workflow execution identifier for fence checking.
   * @returns The durable provisioning ownership decision.
   */
  beginProvisioning(executionAttemptId: string, executionId: string): Promise<ProvisioningClaimDecision>;

  /**
   * Record the provider allocation reference for a provisioning attempt.
   *
   * Called immediately after a provider successfully provisions a resource.
   * Idempotent when called with the same attempt and allocation reference.
   * @param executionAttemptId - The attempt that received the allocation.
   * @param allocationRef - Validated, JSON-safe provider allocation reference.
   */
  recordAllocation(
    executionAttemptId: string,
    allocationRef: ProviderAllocationRef,
  ): Promise<AllocationRecordingDecision>;

  /**
   * Settle a failed provider call before allocation recording.
   * @param executionAttemptId - Provisioning attempt whose provider call failed.
   * @param executionId - Workflow execution identifier for fence checking.
   * @returns The durable failure decision.
   */
  recordProvisioningFailure(executionAttemptId: string, executionId: string): Promise<ProvisioningFailureDecision>;

  /**
   * Retrieve the active attempt for a given execution.
   *
   * Returns `null` when the attempt does not exist or has been superseded
   * (fenced) by a newer attempt for the same execution.
   * @param executionId - Workflow execution identifier.
   * @param executionAttemptId - Attempt identifier to look up.
   * @returns The attempt record if active, or `null`.
   */
  getActiveAttempt(executionId: string, executionAttemptId: string): Promise<ExecutionAttemptRecord | null>;

  /**
   * Commit a terminal outcome for an attempt.
   *
   * The repository makes the durable decision:
   * - `accepted`: first commit for this attempt; outcome is canonical.
   * - `duplicate`: identical outcome already committed; returns it.
   * - `conflict`: different outcome already committed for this attempt.
   * - `fenced`: attempt is no longer active for this execution.
   * @param input - Attempt identity and terminal result to commit.
   * @returns The durable decision with the canonical outcome when applicable.
   */
  commitOutcome(input: ExecutionAttemptOutcomeCommit): Promise<ExecutionAttemptOutcomeDecision>;

  /**
   * Settle a pending attempt when dispatch cannot continue before provisioning.
   * The operation is fenced and idempotent. `provisioning` and `allocated` mean callers must
   * settle the provider allocation through {@link recordInfrastructureFailure}.
   * @param executionAttemptId - Pending attempt to abandon.
   * @param executionId - Workflow execution identifier.
   * @returns The durable abandonment decision.
   */
  abandonPendingAttempt(executionAttemptId: string, executionId: string): Promise<PendingAttemptAbandonmentDecision>;

  /**
   * Record a confirmed infrastructure failure for an allocated attempt.
   * This terminal CAS competes with outcome submission; the first durable
   * transition wins and the loser receives `already-settled`. Pre-allocation
   * provider failures must instead use {@link recordProvisioningFailure}.
   * @param executionAttemptId - Attempt whose allocation terminated.
   * @param executionId - Workflow execution identifier.
   * @returns The infrastructure failure decision.
   */
  recordInfrastructureFailure(executionAttemptId: string, executionId: string): Promise<InfrastructureFailureDecision>;

  // ─────────────────────────────────────────────────────────
  // Recovery Operations (optional)
  //
  // These operations are required only for repositories that
  // support recoverable providers. Repositories that serve
  // only non-recoverable providers (e.g. Piscina) may omit
  // them. The Authority checks for their presence before
  // delegating recovery calls.
  // ─────────────────────────────────────────────────────────

  /**
   * Look up an attempt by its identifier, regardless of active status.
   *
   * Unlike {@link getActiveAttempt}, this returns the attempt even if it
   * has been superseded or settled. Used by recovery flows that need to
   * inspect a specific attempt's allocation state.
   * @param executionAttemptId - The attempt to look up.
   * @returns The attempt record, or `null` if no such attempt exists.
   */
  getAttemptWithAllocation?(executionAttemptId: string): Promise<ExecutionAttemptRecord | null>;

  /**
   * Compare-and-set update of the allocation reference for an active attempt.
   *
   * Used when provider correlation discovers additional identity after the
   * initial allocation (e.g. GitHub Actions run/job ID correlation). The
   * `currentRef` must match the stored reference; if it does not, the update
   * is rejected as stale to prevent lost updates from concurrent correlators.
   *
   * Both `currentRef` and `nextRef` must share the same `providerId`.
   * @param input - CAS evolution input with current and next references.
   * @returns The evolution decision.
   */
  evolveAllocationRef?(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision>;

  /**
   * List all recoverable (allocated, non-settled) attempts for an execution.
   *
   * Returns attempts that have a provider allocation, have not settled
   * (no committed outcome or infrastructure failure), and are still eligible
   * for recovery claims. The caller uses these to drive provider inspect and
   * attach flows.
   *
   * Expired claims (past `claimExpiresAt`) are excluded.
   * @param executionId - Workflow execution identifier.
   * @returns Allocated, non-settled attempts eligible for recovery.
   */
  getRecoverableAttempts?(executionId: string): Promise<readonly RecoverableAttemptRecord[]>;
}
