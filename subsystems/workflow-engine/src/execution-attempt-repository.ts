import type {
  BoundedRecoveryEvidence,
  ProviderAllocationRef,
  WorkerAllocationLifetime,
  WorkflowRunResult,
} from '@makaio/contracts';
import { canonicalStringify } from '@makaio/utils';
import type {
  ProcessBoundProvisionerLossProof,
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from './provider-operation.js';

// ─────────────────────────────────────────────────────────────
// Attempt Lifecycle States
// ─────────────────────────────────────────────────────────────

/**
 * Ordered constant array of every execution attempt lifecycle status.
 *
 * The order is the progression an attempt follows. Declaring the vocabulary
 * once lets an implementation validate a stored status against the same list
 * the type is derived from.
 */
export const EXECUTION_ATTEMPT_STATUSES = ['pending', 'provisioning', 'allocated', 'settled'] as const;

/**
 * Lifecycle status of an execution attempt.
 *
 * - `pending`: attempt created but provider provisioning has not started.
 * - `provisioning`: a provider call is in flight but no allocation is recorded.
 * - `allocated`: a provider has accepted the attempt and recorded an allocation.
 * - `settled`: the attempt has a committed terminal outcome (accepted or failed).
 */
export type ExecutionAttemptStatus = (typeof EXECUTION_ATTEMPT_STATUSES)[number];

/**
 * Constant array of every way a settled attempt can have reached its terminal
 * state. `null` is deliberately absent: it means "not settled at all", which
 * is the absence of a settlement rather than one of its kinds.
 */
export const EXECUTION_ATTEMPT_SETTLEMENT_KINDS = ['outcome', 'abandoned', 'infrastructure-failure'] as const;

/**
 * How a settled attempt reached its terminal state.
 *
 * - `outcome`: a worker submitted a workflow result that was accepted.
 * - `infrastructure-failure`: the provider allocation terminated without
 *   an acknowledged worker outcome. The workflow run may be retried.
 * - `abandoned`: dispatch ended before allocation, including a positively
 *   proven absence recorded through
 *   {@link ExecutionAttemptRepository.recordProvisioningAbsent} or a
 *   process-bound provisioner loss recorded through
 *   {@link ExecutionAttemptRepository.recordProvisionerIncarnationLost}.
 *
 * `null` when the attempt has not yet settled.
 */
export type ExecutionAttemptSettlementKind = (typeof EXECUTION_ATTEMPT_SETTLEMENT_KINDS)[number] | null;

// ─────────────────────────────────────────────────────────────
// Value Equality
//
// Two of the port's decisions turn on whether a value the caller presented is
// the value the attempt already holds. Both comparisons are specified here,
// as functions, so no realization can pick its own rule: the values involved
// carry provider-owned records whose key order is an artifact of however they
// were built, parsed, or round-tripped through storage, and a store that
// normalizes key order would otherwise disagree with one that does not.
// ─────────────────────────────────────────────────────────────

/**
 * Compare two provider allocation references as values.
 *
 * `providerData` is an opaque provider-owned record, so equality is over the
 * canonical serialization rather than over a literal one: two references are
 * the same reference when they carry the same members with the same values,
 * whatever order those members happen to be in. Array order stays significant,
 * because array position is part of the value.
 * @param stored - Reference the attempt currently holds.
 * @param candidate - Reference the caller presented.
 * @returns `true` when the two denote the same allocation reference.
 */
export function sameAllocationRef(stored: ProviderAllocationRef, candidate: ProviderAllocationRef): boolean {
  return canonicalStringify(stored) === canonicalStringify(candidate);
}

/**
 * Compare two terminal workflow results as values.
 *
 * The rule {@link sameAllocationRef} states, for the same reason: a result may
 * carry caller-authored data whose key order is incidental, and a replay of the
 * identical result must be reported as `duplicate` by every realization.
 * @param committed - Result already committed for the attempt.
 * @param candidate - Result the caller presented.
 * @returns `true` when the two denote the same terminal result.
 */
export function sameWorkflowResult(committed: WorkflowRunResult, candidate: WorkflowRunResult): boolean {
  return canonicalStringify(committed) === canonicalStringify(candidate);
}

/**
 * Rejection of an attempt identifier that already names a durable attempt.
 *
 * Named so that every realization reports the same failure for the same cause,
 * and so a caller can tell a reused identifier apart from a storage fault
 * without matching on message text. A realization that detects the collision
 * through a unique-constraint violation rather than a prior read translates
 * that violation into this error before it leaves
 * {@link ExecutionAttemptRepository.createAttempt}.
 */
export class DuplicateExecutionAttemptError extends Error {
  /** Attempt identifier that already exists. */
  public readonly executionAttemptId: string;

  /**
   * @param executionAttemptId - Attempt identifier that already exists.
   * @param options - Standard error options, carrying the driver failure as `cause` where one exists.
   */
  public constructor(executionAttemptId: string, options?: ErrorOptions) {
    super(`Execution attempt '${executionAttemptId}' already exists`, options);
    this.name = 'DuplicateExecutionAttemptError';
    this.executionAttemptId = executionAttemptId;
  }
}

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
   * Provider bound to this attempt, or `null` before provisioning began.
   *
   * Written exactly once, atomically, by the first successful
   * {@link ExecutionAttemptRepository.beginProvisioning}. It never changes
   * afterwards: an attempt belongs to one provider for its whole life, and a
   * different provider means a different attempt.
   */
  readonly providerId: string | null;
  /**
   * Allocation lifetime declared by the bound provider, or `null` before
   * provisioning began.
   *
   * Immutable alongside {@link providerId}. Remediation reads it to decide
   * whether losing the provisioning process also loses the allocation.
   */
  readonly allocationLifetime: WorkerAllocationLifetime | null;
  /**
   * Provisioner process incarnation that performed the provider call, or
   * `null` before provisioning began.
   *
   * Immutable alongside {@link providerId}. Process-loss proof is accepted
   * only when it names exactly this incarnation.
   */
  readonly provisionerIncarnationId: string | null;
  /**
   * How this attempt reached its terminal state.
   *
   * `null` while the attempt is `pending`, `provisioning`, or `allocated`. Set to `'outcome'`
   * when a worker outcome is committed, or `'infrastructure-failure'` when
   * the provider allocation terminated without an acknowledged outcome, or
   * `'abandoned'` when dispatch ends before allocation or absence is proven.
   */
  readonly settlementKind?: ExecutionAttemptSettlementKind;
  /**
   * Whether this attempt is eligible for bootstrap claims.
   *
   * Set to `true` when the active attempt is allocated and a recovery-capable
   * provider is assigned. Cleared when the attempt settles or is replaced.
   * An attempt that is no longer the active attempt for its execution never
   * becomes bootstrap-claimable, even when remediation records an allocation
   * for it.
   */
  readonly claimable?: boolean;
  /**
   * ISO-8601 timestamp after which claim eligibility expires.
   *
   * `null` when claim eligibility has no expiry or the attempt is not
   * claimable, which is what {@link ExecutionAttemptRepository.createAttempt}
   * establishes.
   *
   * The host application owns claim expiry outright: no transition on this
   * port ever writes this field. The host sets it through whatever path
   * issues its bootstrap claims, and the port's obligations are to preserve
   * it across every transition, report it on every read, and honour it in
   * {@link ExecutionAttemptRecoveryOperations.getRecoverableAttempts}. An
   * implementation that reset it during an unrelated transition would extend
   * a claim window the host had already closed.
   */
  readonly claimExpiresAt?: string | null;
}

/**
 * An allocated attempt that is eligible for recovery.
 *
 * Guarantees that `allocationRef` is non-null, status is `'allocated'`,
 * the attempt has not settled, and the immutable provider binding is
 * populated. Used as the return type of
 * {@link ExecutionAttemptRecoveryOperations.getRecoverableAttempts} to give
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
  /** Always bound for recoverable attempts. */
  readonly providerId: string;
  /** Always bound for recoverable attempts. */
  readonly allocationLifetime: WorkerAllocationLifetime;
  /** Always bound for recoverable attempts. */
  readonly provisionerIncarnationId: string;
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
 * Input for claiming the provisioning phase of an attempt.
 *
 * Carries both the immutable provider binding written by the first successful
 * begin and the host-owned initial claim context. The repository writes them
 * in one transaction, so an attempt can never be bound to a provider without
 * an owned operation, or vice versa.
 */
export interface BeginProvisioningInput {
  /** Attempt whose provider call is about to begin. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier the attempt must belong to. */
  readonly executionId: string;
  /** Provider to bind to the attempt, immutably. */
  readonly providerId: string;
  /** Allocation lifetime declared by that provider, immutably. */
  readonly allocationLifetime: WorkerAllocationLifetime;
  /** Provisioner process incarnation performing the call, immutably. */
  readonly provisionerIncarnationId: string;
  /** Controller process incarnation that will hold the initial claim. */
  readonly ownerId: string;
  /** ISO-8601 deadline for the initial lease. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for committing a terminal outcome to an attempt.
 *
 * The repository makes the durable accept/duplicate/conflict/fence decision
 * and returns the canonical outcome for convergence. Outcome commitment
 * carries no claim: a worker's answer never depends on who currently owns
 * the attempt's provider operation.
 */
export interface ExecutionAttemptOutcomeCommit {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Workflow execution identifier. */
  readonly executionId: string;
  /** Terminal workflow result to commit. */
  readonly result: WorkflowRunResult;
}

/** Input for extending the lease of a currently held provider operation. */
export interface RenewProviderOperationClaimInput {
  /** Claim the caller currently believes it holds. */
  readonly claim: ProviderOperationClaim;
  /** New ISO-8601 lease deadline. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for taking ownership of an unowned or expired provider operation.
 *
 * Takeover needs no prior claim — that is the point. It succeeds only when
 * the operation is unowned or its lease has expired relative to `observedAt`,
 * and it always increments the generation so every claim issued before it is
 * fenced immediately.
 */
export interface TakeOverProviderOperationInput {
  /** Attempt whose provider operation is being taken over. */
  readonly executionAttemptId: string;
  /** Controller process incarnation requesting ownership. */
  readonly ownerId: string;
  /** ISO-8601 observation time used to evaluate lease expiry. */
  readonly observedAt: string;
  /** ISO-8601 deadline for the new lease. */
  readonly leaseExpiresAt: string;
}

/**
 * Input for releasing a held provider operation without resolving it.
 *
 * Handoff is a graceful release, not a failure: optional evidence explains
 * why control was released but does not count towards the failure total.
 */
export interface HandoffProviderOperationInput {
  /** Claim being released. */
  readonly claim: ProviderOperationClaim;
  /** Optional bounded evidence explaining the release. */
  readonly evidence?: BoundedRecoveryEvidence;
}

/**
 * Input for recording that a provider observation stayed inconclusive.
 *
 * Uncertainty is the only honest record for an ambiguous provider result. It
 * retains the current obligation and never terminalizes the attempt.
 */
export interface RecordProviderOperationUncertaintyInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Bounded evidence describing what blocked a conclusion. */
  readonly evidence: BoundedRecoveryEvidence;
}

/** Input for recording an allocation reference against a held operation. */
export interface RecordAllocationInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /**
   * Validated, JSON-safe provider allocation reference.
   *
   * Its `providerId` must equal the attempt's immutable `providerId`. An
   * attempt belongs to one provider for its whole life, so a reference naming
   * a different one cannot describe this attempt's infrastructure, and storing
   * it would durably point remediation at a provider that never allocated
   * anything for it.
   */
  readonly allocationRef: ProviderAllocationRef;
}

/**
 * Input for recording positively proven absence of any allocation.
 *
 * `executionId` is an ownership consistency check — the attempt must belong
 * to the named execution. It is deliberately not an active-attempt fence:
 * an open operation stays remediable after its attempt is superseded.
 */
export interface RecordProvisioningAbsentInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Workflow execution identifier the attempt must belong to. */
  readonly executionId: string;
  /** Bounded evidence supporting the absence claim. */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * Input for closing pre-allocation debt on proven provisioner-process loss.
 *
 * `executionId` is an ownership consistency check, exactly as it is for
 * {@link RecordProvisioningAbsentInput}. The proof is passed whole rather than
 * decomposed, so an implementation cannot accept an incarnation identifier
 * without the bounded evidence that supports it.
 */
export interface RecordProvisionerIncarnationLostInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Workflow execution identifier the attempt must belong to. */
  readonly executionId: string;
  /** Proof that a specific provisioner process incarnation is gone. */
  readonly proof: ProcessBoundProvisionerLossProof;
}

/** Input for recording confirmed termination of a known allocation. */
export interface RecordAllocationTerminatedInput {
  /** Claim authorizing the record. */
  readonly claim: ProviderOperationClaim;
  /** Bounded evidence supporting the termination claim. */
  readonly evidence: BoundedRecoveryEvidence;
}

/**
 * Input for settling an allocated attempt as an infrastructure failure.
 *
 * `executionId` is an ownership consistency check, not an active-attempt
 * fence.
 */
export interface RecordInfrastructureFailureInput {
  /** Claim authorizing the settlement. */
  readonly claim: ProviderOperationClaim;
  /** Workflow execution identifier the attempt must belong to. */
  readonly executionId: string;
}

/**
 * Input for a compare-and-set evolution of an allocation reference.
 *
 * Used when provider correlation updates the reference after initial
 * allocation (for example when a hosted runner's run and job identity only
 * become known after the dispatch call has already returned).
 *
 * The repository must verify that `currentRef` matches the stored
 * allocation reference for the claimed attempt. If it does not match,
 * the evolution is rejected to prevent lost updates.
 */
export interface AllocationRefEvolution {
  /** Claim authorizing the evolution. */
  readonly claim: ProviderOperationClaim;
  /** Workflow execution identifier the attempt must belong to. */
  readonly executionId: string;
  /**
   * The allocation reference the caller believes is currently stored.
   *
   * Compared against the stored reference by {@link sameAllocationRef}, and
   * that comparison alone decides whether the evolution is permitted. A
   * realization may additionally guard its write on the stored row being
   * unchanged since it read — that is a concurrency guard over its own
   * storage, and it answers a different question than the one the caller is
   * owed a decision about.
   */
  readonly currentRef: ProviderAllocationRef;
  /** The new allocation reference to store if the CAS check passes. */
  readonly nextRef: ProviderAllocationRef;
}

// ─────────────────────────────────────────────────────────────
// Repository Decisions
// ─────────────────────────────────────────────────────────────

/**
 * Durable decision for claiming provider provisioning ownership.
 *
 * `started` alone authorizes a provider call, and it carries the only claim
 * that can authorize the provider-side records which follow. Every other
 * decision denies a new call because provisioning already began, or the
 * attempt is allocated, resolved, superseded, or unknown.
 *
 * - `started`: this caller now owns the operation and may call the provider.
 * - `already-provisioning`: a begin already succeeded for this attempt. The
 *   caller must converge the existing operation instead of calling again.
 * - `allocated`: an allocation is already recorded for this attempt.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `fenced`: the attempt exists but is no longer the active attempt for its
 *   execution, so it may not bootstrap a new provider call.
 * - `not-found`: no such attempt for the given execution.
 */
export type ProvisioningClaimDecision =
  | { readonly kind: 'started'; readonly claim: ProviderOperationClaim }
  | { readonly kind: 'already-provisioning' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'fenced' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording an allocation reference.
 *
 * `recorded` and `duplicate` confirm that the caller owns `allocationRef`.
 * Every other decision denies ownership and carries an existing reference when
 * one exists, preserving durable evidence for diagnostics and reconciliation.
 *
 * - `recorded`: the reference was stored and the operation now owns the
 *   allocation.
 * - `duplicate`: a reference {@link sameAllocationRef} judges identical was
 *   already stored; this is a replay.
 * - `conflict`: a different reference is already stored for this attempt.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationRecordingDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'duplicate'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'conflict'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved'; readonly allocationRef: ProviderAllocationRef | null }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording an allocation found by provider discovery.
 *
 * Shares the vocabulary of {@link AllocationRecordingDecision} because the
 * outcomes are the same; the two differ in effect, not in reporting. A
 * discovered allocation never makes its attempt bootstrap-claimable.
 */
export type DiscoveredAllocationDecision = AllocationRecordingDecision;

/**
 * Durable decision for recording positively proven pre-allocation absence.
 *
 * - `recorded`: absence evidence was stored, the attempt settled as
 *   `abandoned`, and the operation closed — all in one transaction.
 * - `allocated`: an allocation won the race. Absence must never terminalize
 *   an attempt that owns live infrastructure.
 * - `resolved`: the attempt has already settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProvisioningAbsenceDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for closing pre-allocation debt on proven loss of the
 * provisioner process incarnation.
 *
 * The counterpart of {@link ProvisioningAbsenceDecision} for the one lifetime
 * where nothing needs to be observed to conclude: a
 * `provisioner-process-bound` allocation cannot outlive the process that
 * created it, so proof that the exact recorded incarnation is gone is proof
 * that no allocation survives. Every refusal below is a statement about why the
 * proof does not apply, and each is reported distinctly because they oblige the
 * caller to do different things.
 *
 * - `recorded`: the proof was stored, the attempt settled as `abandoned`, and
 *   the operation closed — all in one transaction.
 * - `not-process-bound`: the attempt's recorded lifetime is not
 *   `provisioner-process-bound`, so losing a process says nothing about its
 *   allocation. The reported lifetime is the stored one, `null` before
 *   provisioning began.
 * - `incarnation-mismatch`: the proof names a different provisioner
 *   incarnation, or the attempt has none recorded, so the proof says nothing
 *   about this attempt. The reported identifier is the stored one.
 * - `allocated`: an allocation is already recorded, so the attempt owes
 *   allocation control rather than pre-allocation closure. Terminate the known
 *   allocation instead of closing the attempt from a proof.
 * - `resolved`: the attempt has already settled; the operation is closed.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt, or it does not
 *   belong to the named execution.
 */
export type ProvisionerIncarnationLossDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'not-process-bound'; readonly allocationLifetime: WorkerAllocationLifetime | null }
  | { readonly kind: 'incarnation-mismatch'; readonly provisionerIncarnationId: string | null }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for settling an allocated attempt as an infrastructure
 * failure.
 *
 * This terminal CAS competes with outcome submission; the first durable
 * transition wins and the loser observes `resolved`.
 *
 * - `recorded`: the failure was persisted, the attempt settled, and the
 *   operation closed.
 * - `resolved`: the attempt already has a terminal settlement.
 * - `not-allocated`: the attempt owns no allocation, so it cannot have
 *   suffered an infrastructure failure. Prove absence instead.
 * - `not-terminated`: the attempt owns an allocation whose termination has not
 *   been confirmed, so the operation still owes `allocation-control`. Confirm
 *   the termination through {@link ExecutionAttemptRepository.recordAllocationTerminated}
 *   first. Reported distinctly from `stale` for the same reason
 *   {@link AllocationTerminationDecision} separates the two: the caller's
 *   authority is current, and what it must do next is supply the missing
 *   transition rather than re-read ownership.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type InfrastructureFailureDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'not-terminated' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording confirmed termination of a known allocation.
 *
 * It extends the shared mutation vocabulary with the one refusal that is not a
 * staleness signal. `stale` says the caller's authority is gone and it must
 * re-read; `not-allocated` says the caller's authority is current and the
 * operation simply owns nothing to terminate. Collapsing the two would let a
 * fenced controller mistake itself for a current one with no allocation, and
 * choose a write path on that mistake.
 *
 * - `recorded`: the obligation advanced to `terminal-convergence`.
 * - `not-allocated`: the claim is current, but no allocation is known for the
 *   attempt. Prove absence instead of claiming termination.
 * - `stale`: the claim no longer matches durable ownership.
 * - `resolved`: the attempt has settled, so the operation is closed.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationTerminationDecision = ProviderOperationMutationDecision | { readonly kind: 'not-allocated' };

/**
 * Durable decision for a compare-and-set allocation reference evolution.
 *
 * - `evolved`: the reference was successfully updated.
 * - `stale`: the caller's view is out of date — either `currentRef` does not
 *   match the stored reference, or the claim no longer matches durable
 *   ownership. `storedRef` carries the current reference when one exists.
 * - `resolved`: the attempt has settled; the operation is closed.
 * - `not-allocated`: the attempt has no allocation to evolve.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type AllocationRefEvolutionDecision =
  | { readonly kind: 'evolved' }
  | { readonly kind: 'stale'; readonly storedRef: ProviderAllocationRef | null }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-allocated' }
  | { readonly kind: 'not-found' };

/** Durable decision for an attempt that failed before provider provisioning began. */
export type PendingAttemptAbandonmentDecision =
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'already-abandoned' }
  | { readonly kind: 'already-settled' }
  | { readonly kind: 'allocated' }
  | { readonly kind: 'provisioning' }
  | { readonly kind: 'fenced' };

/**
 * Durable outcome decision returned by {@link ExecutionAttemptRepository.commitOutcome}.
 *
 * - `accepted`: the outcome was committed as canonical for the first time.
 * - `duplicate`: an outcome {@link sameWorkflowResult} judges identical to the
 *   committed one was submitted again; this is a replay. The committed outcome
 *   is reported, never the caller's copy of it.
 * - `conflict`: the attempt already reached a different terminal state — either
 *   a different committed outcome, or a competing terminal transition that
 *   settled it without one.
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
 * The consuming host application owns the concrete implementation and all
 * durable decisions. The Authority service calls through this port but never
 * owns the underlying tables or storage.
 *
 * The port owns two related records per attempt: canonical attempt state, and
 * the fenced provider operation that tracks who may act on the attempt's
 * infrastructure. Two rules follow from that split and bind every
 * implementation:
 *
 * 1. **The state machine is repository-owned.** No mutation accepts an
 *    obligation, and no caller can choose one. The stored obligation moves
 *    only along the transitions below, never backwards:
 *
 * ```text
 * begin                       => provisioning-resolution
 * record allocation/discovery => allocation-control
 * record confirmed absence    => settled(abandoned) + operation closed
 * prove provisioner loss      => settled(abandoned) + operation closed
 * record termination          => terminal-convergence
 * infrastructure failure CAS  => settled(infrastructure-failure) + closed
 * uncertainty                 => retain current obligation
 * ```
 *
 *    The two pre-allocation closers are deliberately separate. Confirmed
 *    absence is a provider's positive conclusion that nothing was created;
 *    proven provisioner loss is a host's positive conclusion that nothing
 *    survives. Neither is expressible as the other, and neither is implied by
 *    an expired lease.
 *
 *    The table is also read downwards as a precondition: each transition is
 *    reachable only from the obligation the line above it establishes. One
 *    case is worth naming because it spans two calls rather than one.
 *    {@link recordInfrastructureFailure} is reachable **only** from
 *    `terminal-convergence`, so an allocated attempt reaches
 *    `settled(infrastructure-failure)` exclusively by first confirming
 *    termination through {@link recordAllocationTerminated}. An
 *    implementation that settles straight out of `allocation-control` would
 *    let a caller assert that infrastructure ended without ever recording the
 *    evidence that it did, and the settlement is irreversible.
 *
 * 2. **Provider-side evidence is claim-fenced; workflow outcome is not.**
 *    Every provider-side mutation requires the current generation and token.
 *    {@link commitOutcome} deliberately requires neither, so a worker can
 *    always deliver its canonical answer.
 *
 * An operation stays remediable after its attempt stops being the active
 * attempt for its execution. Claim-fenced discovery, absence, cleanup, and
 * terminal convergence may update such an attempt and close its operation,
 * but must never change which attempt is active, reactivate it, or make it
 * bootstrap-claimable.
 *
 * **Timestamps this port orders are instants, not strings.** Every ISO-8601
 * value the port itself compares or sorts by — lease deadlines, takeover
 * observation times, claim expiry, creation time — is stored canonically UTC
 * with millisecond precision, exactly the form `Date.prototype.toISOString`
 * produces (`YYYY-MM-DDTHH:mm:ss.sssZ`). An implementation normalizes those to
 * that form before storing them, and orders them as instants. A store with
 * native temporal types therefore compares the same way a lexicographic
 * comparison of the canonical form does, and an offset-bearing or
 * second-precision input can never silently mis-order a lease.
 *
 * `BoundedRecoveryEvidence.observedAt` is deliberately outside that rule. The
 * port never orders by it: evidence is retained and reported, never compared.
 * It is a public contract value its producer authored — commonly a provider
 * describing an instant in the zone its own infrastructure reported — and
 * `BoundedRecoveryEvidenceSchema` accepts a numeric offset on purpose. An
 * implementation therefore stores evidence exactly as validated and reports it
 * back verbatim, rewriting no field of it. Normalizing it would silently
 * change a value the producer asserted, and would make two conforming
 * implementations disagree on what a provider said.
 *
 * Durable records carry only JSON-safe, non-secret values: credential
 * references and bounded recovery evidence, never plaintext credentials,
 * stack traces, or raw provider responses.
 *
 * **Input validation precedes every durable decision.** Bounded recovery
 * evidence supplied to a mutation is validated against
 * `BoundedRecoveryEvidenceSchema` before ownership, execution membership, or
 * attempt state is consulted. Evidence that violates the contract is a caller
 * bug, not an outcome, so it is rejected rather than answered with a decision
 * — including when the caller's claim is also stale. Validating after the
 * guards would make the rejection depend on ownership, so the same malformed
 * payload would throw against one implementation and return `stale` from
 * another.
 */
export interface ExecutionAttemptRepository {
  /**
   * Persist a new execution attempt record.
   *
   * Called by the Authority before dispatch. The Authority owns
   * `executionAttemptId` generation; the repository only persists. The new
   * attempt atomically becomes the active attempt for its execution.
   *
   * `executionAttemptId` is unique for all time. Creating an attempt whose
   * identifier already exists is a caller bug and is rejected — never
   * answered with a decision and never applied. There is no correct way to
   * apply it: the identifier may name an attempt that already owns provider
   * infrastructure, a committed outcome, or a terminal settlement, and a
   * fresh `pending` record in its place would discard all three while
   * orphaning the operation beside it.
   *
   * The rejection is a {@link DuplicateExecutionAttemptError}, whichever way
   * the realization detected the collision. Detecting it by reading first and
   * detecting it from a unique-constraint violation are both conforming — the
   * second is the only race-free option on a store that does not serialize
   * writers — but a realization that lets the driver's own error escape would
   * make the same caller bug indistinguishable from a storage fault, and
   * distinguishable only by message text between one realization and another.
   * @param input - Attempt identity to persist.
   * @returns The created attempt record.
   * @throws A {@link DuplicateExecutionAttemptError} when an attempt with the same `executionAttemptId` already exists.
   */
  createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord>;

  /**
   * Claim the durable provisioning phase immediately before a provider call.
   *
   * This is the sole authorization for invoking a provider, and it succeeds at
   * most once per attempt. The same transaction binds the provider, allocation
   * lifetime, and provisioner incarnation immutably, and opens the attempt's
   * provider operation at generation 1 with a fresh token.
   * @param input - Attempt identity, immutable provider binding, and initial claim context.
   * @returns The durable provisioning ownership decision.
   */
  beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision>;

  /**
   * Read the current provider operation for an attempt.
   * @param executionAttemptId - Attempt whose operation to read.
   * @returns The ownership record, or `null` when provisioning never began.
   */
  getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null>;

  /**
   * Extend the lease of a currently held provider operation.
   *
   * Preserves the generation and token: renewal is not a new claim, so it
   * cannot fence anyone.
   * @param input - Current claim and the new lease deadline.
   * @returns The durable claim decision.
   */
  renewProviderOperationClaim(input: RenewProviderOperationClaimInput): Promise<ProviderOperationClaimDecision>;

  /**
   * Take ownership of an unowned or lease-expired provider operation.
   *
   * Succeeds only when the operation is unowned or its lease has expired at
   * `observedAt`. On success the generation increments and a fresh token is
   * issued, which fences every previously issued claim immediately. The
   * obligation and accumulated evidence are preserved.
   * @param input - Attempt identity, requesting owner, observation time, and lease deadline.
   * @returns The durable claim decision.
   */
  takeOverProviderOperation(input: TakeOverProviderOperationInput): Promise<ProviderOperationClaimDecision>;

  /**
   * Release a held provider operation without resolving it.
   *
   * Atomically verifies the generation and token, preserves both the
   * generation and the obligation, then clears owner, token, and lease.
   * Clearing the token fences the released claim immediately. Because the
   * record is then unowned, takeover may claim it without waiting for the old
   * lease; that claim increments the generation and receives a new token.
   * @param input - Claim being released and optional bounded release evidence.
   * @returns The durable mutation decision.
   */
  handoffProviderOperation(input: HandoffProviderOperationInput): Promise<ProviderOperationMutationDecision>;

  /**
   * Record that a provider observation stayed inconclusive.
   *
   * Retains the current obligation and increments the bounded failure total.
   * Uncertainty never terminalizes an attempt: an ambiguous provider result
   * is not evidence that nothing was created.
   * @param input - Claim and bounded evidence describing the retained uncertainty.
   * @returns The durable mutation decision.
   */
  recordProviderOperationUncertainty(
    input: RecordProviderOperationUncertaintyInput,
  ): Promise<ProviderOperationMutationDecision>;

  /**
   * Record the provider allocation reference for a claimed operation.
   *
   * Called immediately after a provider successfully provisions a resource.
   * Advances the obligation to `allocation-control` and, for the active
   * attempt, marks it bootstrap-claimable. Idempotent for an identical
   * reference.
   *
   * The implementation verifies, inside the same transaction as the write and
   * before any mutation, that the reference names the attempt's immutable
   * `providerId`. Nothing in {@link AllocationRecordingDecision} can report a
   * foreign reference, so a mismatch is a caller bug and is rejected rather
   * than answered — and rejected whatever the claim's state, exactly as
   * malformed evidence is.
   * @param input - Claim and the validated allocation reference.
   * @returns The durable allocation ownership decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision>;

  /**
   * Record positively proven absence of any allocation for the attempt.
   *
   * The atomic terminal CAS for the pre-allocation case: it stores bounded
   * absence evidence, settles the attempt as `abandoned`, and closes the
   * operation in one transaction. It never produces `terminal-convergence` —
   * that obligation is reserved for a known allocation whose termination was
   * already confirmed.
   * @param input - Claim, owning execution, and bounded absence evidence.
   * @returns The durable absence decision.
   */
  recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision>;

  /**
   * Close pre-allocation debt on proof that a provisioner incarnation is gone.
   *
   * The atomic terminal CAS for an attempt whose allocation could not have
   * outlived its provisioner. It exists because such an attempt has no other
   * reachable terminal state: its provider need not advertise recovery, so
   * there may be nothing to discover, inspect, or terminate, and
   * {@link abandonPendingAttempt} refuses an attempt that already began
   * provisioning.
   *
   * The implementation verifies, inside the same transaction as the write,
   * that the attempt's stored `allocationLifetime` is
   * `provisioner-process-bound` and that its immutable
   * `provisionerIncarnationId` is exactly the one the proof names. Both are
   * immutable facts written by {@link beginProvisioning}, so this is a
   * statement about the attempt rather than about the caller's view of it. An
   * expired lease can never satisfy either check.
   *
   * On success it stores the proof's bounded evidence, settles the attempt as
   * `abandoned`, and closes the operation in one transaction. `abandoned` is
   * the honest kind: no allocation was ever recorded for the attempt, so it
   * cannot have suffered an infrastructure failure in the sense
   * {@link recordInfrastructureFailure} defines.
   * @param input - Claim, owning execution, and the provisioner loss proof.
   * @returns The durable provisioner-loss decision.
   */
  recordProvisionerIncarnationLost(
    input: RecordProvisionerIncarnationLostInput,
  ): Promise<ProvisionerIncarnationLossDecision>;

  /**
   * Record a confirmed infrastructure failure for an allocated attempt.
   *
   * This terminal CAS competes with outcome submission; the first durable
   * transition wins and the loser receives `resolved`. Pre-allocation
   * conclusions must instead use {@link recordProvisioningAbsent}.
   *
   * It is reachable only from `terminal-convergence`. The implementation
   * verifies the stored obligation inside the settling transaction and refuses
   * an operation that still owes `allocation-control` as `not-terminated`, so
   * the evidence that the allocation ended is always durable before the
   * attempt is settled on the strength of it. That makes
   * {@link recordAllocationTerminated} the single entry to terminal
   * settlement, and it is what lets a pass interrupted between the two retry
   * only the settlement.
   * @param input - Claim and the owning execution.
   * @returns The infrastructure failure decision.
   */
  recordInfrastructureFailure(input: RecordInfrastructureFailureInput): Promise<InfrastructureFailureDecision>;

  /**
   * Record that a known allocation was confirmed terminated.
   *
   * The explicit monotonic transition from `allocation-control` to
   * `terminal-convergence`, and the only way an allocated attempt becomes
   * eligible for {@link recordInfrastructureFailure}. It does not settle the
   * attempt and does not increment the failure total: a successful termination
   * is not a failure. An operation that owns no allocation cannot make this
   * transition and is told so as `not-allocated`, distinctly from a fenced
   * claim.
   * @param input - Claim and bounded evidence supporting the termination.
   * @returns The durable termination decision.
   */
  recordAllocationTerminated(input: RecordAllocationTerminatedInput): Promise<AllocationTerminationDecision>;

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
   * Deliberately claim-independent: a worker's canonical answer never depends
   * on who currently owns the attempt's provider operation. A successful
   * commit settles the attempt and closes its operation.
   *
   * The repository makes the durable decision in exactly this precedence
   * order. An implementation that reorders it is non-conforming, because each
   * step is only reachable once every earlier one has been ruled out:
   *
   * 1. `fenced` — the attempt is no longer the active attempt for its
   *    execution. Evaluated first because `accepted` and `duplicate` oblige
   *    the caller to converge workflow state, and a superseded attempt must
   *    never drive that convergence.
   * 2. `duplicate` / `conflict` — an outcome is already committed for this
   *    attempt: `duplicate` when {@link sameWorkflowResult} judges it
   *    canonically equal, including member-order-insensitive objects;
   *    `conflict` when it differs under that rule.
   * 3. `conflict` — a competing terminal transition already settled the
   *    attempt without committing an outcome, that is
   *    {@link recordInfrastructureFailure} or
   *    {@link recordProvisioningAbsent} or
   *    {@link recordProvisionerIncarnationLost}. That transition won the
   *    terminal CAS, so a late outcome may neither overwrite its
   *    `settlementKind` nor reopen the attempt.
   * 4. `accepted` — the outcome becomes canonical, the attempt settles as
   *    `outcome`, and its operation closes.
   * @param input - Attempt identity and terminal result to commit.
   * @returns The durable decision with the canonical outcome when applicable.
   */
  commitOutcome(input: ExecutionAttemptOutcomeCommit): Promise<ExecutionAttemptOutcomeDecision>;

  /**
   * Settle a pending attempt when dispatch cannot continue before provisioning.
   *
   * The operation is fenced and idempotent. `provisioning` and `allocated`
   * mean provisioning already began, so the caller must converge the provider
   * operation instead of abandoning the attempt.
   * @param executionAttemptId - Pending attempt to abandon.
   * @param executionId - Workflow execution identifier.
   * @returns The durable abandonment decision.
   */
  abandonPendingAttempt(executionAttemptId: string, executionId: string): Promise<PendingAttemptAbandonmentDecision>;

  /**
   * Recovery operations, present only on a recovery-capable repository.
   *
   * Absent when the repository serves only non-recoverable providers. The
   * Authority reads this one property to decide whether it may delegate, so a
   * repository is either recovery-capable or it is not — there is no partially
   * recoverable repository to reason about.
   */
  readonly recovery?: ExecutionAttemptRecoveryOperations;
}

// ─────────────────────────────────────────────────────────────
// Recovery Operations
// ─────────────────────────────────────────────────────────────

/**
 * Coherent recovery capability of the execution attempt port.
 *
 * Recovery is one indivisible capability: a repository implements all four
 * operations or none. Partial implementation is a type error because all four
 * are required members of this interface, exactly as they are on the provider
 * side of the same capability.
 *
 * The four exist together because a recovery pass needs all of them: it reads
 * a superseded attempt, records what discovery found for it, refines the
 * reference as correlation narrows it, and lists what is still outstanding. A
 * repository that answered three of them would strand the pass at whichever
 * step it omitted, after that pass had already begun acting on infrastructure.
 */
export interface ExecutionAttemptRecoveryOperations {
  /**
   * Look up an attempt by its identifier, regardless of active status.
   *
   * Unlike {@link ExecutionAttemptRepository.getActiveAttempt}, this returns
   * the attempt even if it has been superseded or settled. Used by recovery
   * flows that need to inspect a specific attempt's allocation state.
   * @param executionAttemptId - The attempt to look up.
   * @returns The attempt record, or `null` if no such attempt exists.
   */
  getAttemptWithAllocation(executionAttemptId: string): Promise<ExecutionAttemptRecord | null>;

  /**
   * Record an allocation that provider discovery found for the attempt.
   *
   * Used when a provider call's acknowledgement was lost and an exhaustive
   * lookup later found exactly one matching allocation. It advances the
   * obligation to `allocation-control` exactly like
   * {@link ExecutionAttemptRepository.recordAllocation}, but never marks the
   * attempt bootstrap-claimable and never changes which attempt is active:
   * discovery converges an old attempt, it does not revive it.
   *
   * It enforces the same provider binding as
   * {@link ExecutionAttemptRepository.recordAllocation}, for the same reason: a
   * discovery answer that names another provider describes somebody else's
   * infrastructure.
   * @param input - Claim and the discovered allocation reference.
   * @returns The durable discovered-allocation decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  recordDiscoveredAllocation(input: RecordAllocationInput): Promise<DiscoveredAllocationDecision>;

  /**
   * Compare-and-set update of the allocation reference for a claimed attempt.
   *
   * Used when provider correlation discovers additional identity after the
   * initial allocation. The `currentRef` must match the stored reference under
   * {@link sameAllocationRef}; if it does not, the update is rejected as stale
   * to prevent lost updates from concurrent correlators.
   *
   * Both `currentRef` and `nextRef` must share the same `providerId`:
   * correlation refines one allocation's opaque `providerData`, it never
   * moves an attempt to a different provider. Nothing in
   * {@link AllocationRefEvolutionDecision} can report such a request, so a
   * mismatched pair is a caller bug and is rejected rather than answered.
   * @param input - Claim, owning execution, and current/next references.
   * @returns The evolution decision.
   * @throws When `currentRef` and `nextRef` name different providers.
   */
  evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision>;

  /**
   * List all recoverable (allocated, non-settled) attempts for an execution.
   *
   * Returns attempts that have a provider allocation, have not settled
   * (no committed outcome or infrastructure failure), and are still eligible
   * for recovery claims. The caller uses these to drive provider inspect and
   * attach flows.
   *
   * Expired claims (past `claimExpiresAt`) are excluded.
   *
   * **Ordering is part of the contract:** attempts are returned oldest first,
   * by `createdAt` as an instant, ties broken by ascending
   * `executionAttemptId`. Recovery reclaims infrastructure in the order it was
   * created, and the tiebreak is what keeps two attempts created within the
   * same millisecond from ordering differently on two stores. An
   * implementation that returned an arbitrary order would make a caller that
   * bounds its pass reclaim a different subset on each realization.
   * @param executionId - Workflow execution identifier.
   * @returns Allocated, non-settled attempts eligible for recovery, oldest first.
   */
  getRecoverableAttempts(executionId: string): Promise<readonly RecoverableAttemptRecord[]>;
}
