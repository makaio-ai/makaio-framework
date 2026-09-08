import type { BoundedRecoveryEvidence, ProviderAllocationRef, WorkerAllocationLifetime } from '@makaio/contracts';
import type { ExecutionAttemptRecord } from './execution-attempt-repository.js';

/**
 * Provider-operation ownership protocol.
 *
 * An execution attempt owns canonical workflow state. A *provider operation*
 * is the separate, fenced record of who is currently allowed to act on that
 * attempt's provider-side infrastructure, and what remediation debt is still
 * outstanding for it. Completion is a separate, positive fact: an attempt
 * settlement cannot prove that the provider has released its allocation.
 *
 * The two records are deliberately distinct:
 * - the attempt answers "what is the canonical workflow answer?";
 * - the operation answers "who may talk to the provider right now, and what
 *   does that provider still owe us?".
 *
 * Worker outcome commitment is therefore independent of operation ownership:
 * a worker that produces a result never needs a claim.
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────
// Obligations
// ─────────────────────────────────────────────────────────────

/**
 * Outstanding provider-side debt for one execution attempt.
 *
 * - `provisioning-resolution`: a provider call was authorized but no
 *   allocation is known yet. Either an allocation exists and must be found,
 *   or its absence must be positively proven.
 * - `allocation-control`: an allocation reference is known and the operation
 *   owns its infrastructure lifecycle.
 * - `terminal-convergence`: a known allocation has been confirmed terminated,
 *   and the attempt still needs a canonical workflow answer.
 */
export type ProviderOperationObligation = 'provisioning-resolution' | 'allocation-control' | 'terminal-convergence';

/**
 * Ordered constant array of every provider-operation obligation.
 *
 * The order is the monotonic progression an operation may follow. A stored
 * obligation never moves backwards, and callers never supply it: the durable
 * repository derives it from the transition being applied.
 */
export const PROVIDER_OPERATION_OBLIGATIONS = [
  'provisioning-resolution',
  'allocation-control',
  'terminal-convergence',
] as const satisfies readonly ProviderOperationObligation[];

// ─────────────────────────────────────────────────────────────
// Claims and Ownership
// ─────────────────────────────────────────────────────────────

/**
 * Proof that the holder currently owns an attempt's provider operation.
 *
 * A claim is the only authorization for a provider-side evidence mutation.
 * It is fenced on two axes: `generation` advances on every takeover, and
 * `token` is reissued with it, so a claim from a superseded owner is rejected
 * even if that owner's lease has not visibly expired yet.
 *
 * `ownerId` identifies a controller *process incarnation*. It is not a
 * machine identifier, a workflow node identifier, an execution identifier,
 * or a security principal.
 */
export interface ProviderOperationClaim {
  /** Attempt whose provider operation this claim authorizes. */
  readonly executionAttemptId: string;
  /** Ownership generation this claim was issued for. */
  readonly generation: number;
  /** Controller process incarnation that holds the claim. */
  readonly ownerId: string;
  /** Opaque fencing token issued by the durable repository. */
  readonly token: string;
  /**
   * Instant after which the lease may be taken over.
   *
   * Canonical UTC ISO-8601 with millisecond precision, as issued by the
   * durable repository, and ordered as an instant rather than as text.
   */
  readonly leaseExpiresAt: string;
}

/**
 * Durable ownership and remediation state for one attempt's provider operation.
 *
 * Until {@link isProviderOperationResolved} returns `true`, `ownerId`,
 * `token`, and `leaseExpiresAt` describe the current claim and are all `null`
 * when the operation is unowned. Positive completion evidence may be recorded
 * before the attempt settles; that evidence is immutable, but it does not
 * freeze the live claim or make the operation ineligible for recovery. Once
 * the operation is resolved, the fields retain the final control snapshot,
 * which may be unowned after a handoff and is not proof-writing provenance.
 * `generation` and `obligation` survive both handoff and completion.
 *
 * All fields are JSON-safe and non-secret. `lastFailure` holds bounded
 * evidence only; plaintext credentials, stack traces, and raw provider
 * responses never reach this record.
 */
export interface ProviderOperationOwnershipRecord {
  /** Attempt this operation belongs to. */
  readonly executionAttemptId: string;
  /** Monotonic ownership generation, incremented by every takeover. */
  readonly generation: number;
  /**
   * Current controller process incarnation while unresolved, retained as the
   * final control snapshot once {@link isProviderOperationResolved} returns
   * `true`, or `null` when the operation is unowned.
   */
  readonly ownerId: string | null;
  /**
   * Current fencing token while unresolved, retained as the final control
   * snapshot once {@link isProviderOperationResolved} returns `true`, or
   * `null` when the operation is unowned.
   */
  readonly token: string | null;
  /**
   * Current lease deadline while unresolved, retained with the final control
   * snapshot once {@link isProviderOperationResolved} returns `true`, or
   * `null` when the operation is unowned.
   */
  readonly leaseExpiresAt: string | null;
  /** Outstanding provider-side debt, owned by the durable repository. */
  readonly obligation: ProviderOperationObligation;
  /** Number of recorded uncertainty observations for this operation. */
  readonly failureCount: number;
  /** Most recent bounded evidence recorded against this operation. */
  readonly lastFailure: BoundedRecoveryEvidence | null;
  /**
   * Positive, immutable proof that every provider-side responsibility for this
   * operation is complete, or `null` while the proof has not been observed.
   *
   * This is deliberately independent of the attempt's settlement and of
   * {@link obligation}: a settled attempt can still need provider cleanup, and
   * an unsettled attempt with this proof stays recoverable until it has a
   * canonical settlement.
   */
  readonly completionEvidence: BoundedRecoveryEvidence | null;
}

/**
 * Whether an operation has both of the independent facts needed to resolve it.
 *
 * Provider evidence can arrive before an outcome. That fact must be retained,
 * but it does not close control ownership: recovery may still need to hold or
 * hand off the operation until the attempt settles. Conversely, settlement
 * alone never proves provider work is complete.
 * @param attempt - Minimal durable settlement fact from the attempt record.
 * @param operation - Minimal positive provider-completion fact from the operation record.
 * @returns Whether no provider-operation ownership or recovery work remains.
 */
export function isProviderOperationResolved(
  attempt: Pick<ExecutionAttemptRecord, 'settlementKind'>,
  operation: Pick<ProviderOperationOwnershipRecord, 'completionEvidence'>,
): boolean {
  return attempt.settlementKind !== null && operation.completionEvidence !== null;
}

// ─────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────

/**
 * Durable decision for acquiring or extending provider-operation ownership.
 *
 * - `claimed`: the caller now holds the operation; the returned claim is the
 *   only value that authorizes subsequent provider-side mutations.
 * - `stale`: the request does not match durable ownership — a superseded
 *   generation or token on renewal, or a lease that has not expired yet on
 *   takeover. The caller must re-read before retrying.
 * - `resolved`: positive completion evidence and attempt settlement were both
 *   recorded, so there is nothing left to own. Neither fact alone produces
 *   this decision.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProviderOperationClaimDecision =
  | { readonly kind: 'claimed'; readonly claim: ProviderOperationClaim }
  | { readonly kind: 'stale' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for a claim-fenced mutation of provider-operation state.
 *
 * - `recorded`: the mutation was applied.
 * - `stale`: the caller's view of durable state is out of date — either the
 *   claim no longer matches the stored generation/token, or the stored
 *   obligation cannot make the requested transition. In both cases the
 *   caller must re-read; it may not pick a different write path instead.
 * - `resolved`: positive completion evidence and attempt settlement were both
 *   recorded, so the operation is closed.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProviderOperationMutationDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording positive completion of a provider operation.
 *
 * Completion evidence is immutable once written. The repository validates the
 * current claim before recording it, and no later call can replace the first
 * proof. `evidence-recorded` means the evidence is durable but the attempt
 * remains unsettled, so the operation stays recoverable. `completed` means
 * the same write also resolves the operation because the attempt was already
 * settled. Replaying after evidence exists but before settlement returns
 * `evidence-recorded`; replaying after resolution returns `already-completed`.
 */
export type ProviderOperationCompletionDecision =
  | { readonly kind: 'evidence-recorded' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'already-completed' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

/**
 * Durable decision for recording positively proven pre-allocation absence.
 *
 * - `recorded`: absence evidence was stored and the same positive proof
 *   completed the operation while newly settling the attempt as `abandoned`.
 * - `completed`: absence evidence was stored and completed the operation, but
 *   an existing canonical settlement was preserved — all in one transaction.
 * - `allocated`: an allocation won the race. Absence must never terminalize
 *   an attempt that owns live infrastructure.
 * - `resolved`: positive provider completion evidence and attempt settlement
 *   were already recorded.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProvisioningAbsenceDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'completed' }
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
 * - `recorded`: the proof was stored and the same positive proof completed the
 *   operation while newly settling the attempt as `abandoned`.
 * - `completed`: the proof was stored and completed the operation, but an
 *   existing canonical settlement was preserved — all in one transaction.
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
 * - `resolved`: positive provider completion evidence and attempt settlement
 *   were already recorded.
 * - `stale`: the claim no longer matches durable ownership.
 * - `not-found`: no provider operation exists for the attempt, or it does not
 *   belong to the named execution.
 */
export type ProvisionerIncarnationLossDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'not-process-bound'; readonly allocationLifetime: WorkerAllocationLifetime | null }
  | { readonly kind: 'incarnation-mismatch'; readonly provisionerIncarnationId: string | null }
  | { readonly kind: 'allocated'; readonly allocationRef: ProviderAllocationRef }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'not-found' };

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

/** Input for recording positive completion evidence of a provider operation. */
export interface CompleteProviderOperationInput {
  /** Claim that currently owns the provider operation. */
  readonly claim: ProviderOperationClaim;
  /** Bounded, durable, non-secret proof that provider work is complete. */
  readonly evidence: BoundedRecoveryEvidence;
}

/** Bounded, caller-timed selector for provider operations eligible for takeover. */
export interface ListOpenProviderOperationsInput {
  /** ISO-8601 instant at which the caller observed lease eligibility. */
  readonly observedAt: string;
  /** Positive safe-integer maximum number of records to return; no implicit default exists. */
  readonly limit: number;
}

/**
 * One provider operation that still needs infrastructure work.
 *
 * The joined shape returns the existing durable attempt and operation records
 * rather than introducing another lifecycle ledger. The operation is open
 * when {@link isProviderOperationResolved} returns `false`; its completion
 * evidence and settlement may each be present independently.
 */
export interface OpenProviderOperationRecord {
  /** Attempt whose provider-side infrastructure remains open. */
  readonly attempt: ExecutionAttemptRecord;
  /** Open provider operation, including current or expired claim facts. */
  readonly operation: ProviderOperationOwnershipRecord;
}

// ─────────────────────────────────────────────────────────────
// Host-Owned Initial Claim Context
// ─────────────────────────────────────────────────────────────

/**
 * Controller identity and lease policy for an attempt's first claim.
 *
 * Supplied by the host, never invented by the code that dispatches work.
 * A dispatcher knows which attempt it is starting; it does not know which
 * process incarnation it belongs to or how long a lease should last.
 */
export interface InitialProviderOperationClaimContext {
  /** Controller process incarnation that will hold the initial claim. */
  readonly ownerId: string;
  /**
   * Provisioner process incarnation that performs the provider call.
   *
   * Stable for the lifetime of the provisioning process. It is never
   * regenerated per attempt: process-loss proof is only meaningful when the
   * recorded incarnation identifies the process that actually provisioned.
   */
  readonly provisionerIncarnationId: string;
  /** ISO-8601 deadline for the initial lease, per host lease policy. */
  readonly leaseExpiresAt: string;
}

/**
 * Host seam that produces the initial claim context for an attempt.
 *
 * Hosts implement this to inject controller identity and lease policy.
 * There is deliberately no default implementation and no default lease
 * duration: a hidden default would silently attach remediation authority to
 * an anonymous owner.
 */
export interface InitialProviderOperationClaimContextSource {
  /**
   * Produce the initial claim context for one attempt about to be provisioned.
   * @param input - Execution, attempt, and provider the claim is being created for.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Controller identity, provisioner incarnation, and lease deadline.
   */
  create(
    input: {
      /** Workflow execution identifier. */
      readonly executionId: string;
      /** Attempt identifier the claim is created for. */
      readonly executionAttemptId: string;
      /** Provider identifier that will be bound to the attempt. */
      readonly providerId: string;
    },
    signal: AbortSignal,
  ): Promise<InitialProviderOperationClaimContext>;
}

// ─────────────────────────────────────────────────────────────
// Process-Bound Loss Proof
// ─────────────────────────────────────────────────────────────

/**
 * Positive proof that a specific provisioner process incarnation is gone.
 *
 * Only meaningful for attempts whose allocation lifetime is
 * `provisioner-process-bound`: such an allocation cannot outlive the process
 * that created it, so proving that process is gone proves the allocation is
 * gone too.
 *
 * A remediator may act on this proof only when `provisionerIncarnationId`
 * exactly equals the attempt's immutable `provisionerIncarnationId`. Proof
 * naming a different incarnation says nothing about this attempt.
 *
 * An expired lease is never such proof: leases expire for slow controllers
 * as readily as for dead ones.
 */
export interface ProcessBoundProvisionerLossProof {
  /** Discriminant for provisioner incarnation loss. */
  readonly kind: 'provisioner-incarnation-lost';
  /** Provisioner process incarnation this proof is about. */
  readonly provisionerIncarnationId: string;
  /** Bounded, durable, non-secret evidence supporting the loss claim. */
  readonly evidence: BoundedRecoveryEvidence;
}
