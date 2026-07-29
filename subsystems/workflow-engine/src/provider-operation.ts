import type { BoundedRecoveryEvidence } from '@makaio/contracts';

/**
 * Provider-operation ownership protocol.
 *
 * An execution attempt owns canonical workflow state. A *provider operation*
 * is the separate, fenced record of who is currently allowed to act on that
 * attempt's provider-side infrastructure, and what remediation debt is still
 * outstanding for it.
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
 * `ownerId`, `token`, and `leaseExpiresAt` are all `null` when the operation
 * is unowned — either because it was handed off, or because it was closed
 * when the attempt settled. `generation` and `obligation` survive both.
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
  /** Current controller process incarnation, or `null` when unowned. */
  readonly ownerId: string | null;
  /** Current fencing token, or `null` when unowned. */
  readonly token: string | null;
  /** ISO-8601 lease deadline, or `null` when unowned. */
  readonly leaseExpiresAt: string | null;
  /** Outstanding provider-side debt, owned by the durable repository. */
  readonly obligation: ProviderOperationObligation;
  /** Number of recorded uncertainty observations for this operation. */
  readonly failureCount: number;
  /** Most recent bounded evidence recorded against this operation. */
  readonly lastFailure: BoundedRecoveryEvidence | null;
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
 * - `resolved`: the attempt has settled, so the operation is closed and
 *   there is nothing left to own.
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
 * - `resolved`: the attempt has settled, so the operation is closed.
 * - `not-found`: no provider operation exists for the attempt.
 */
export type ProviderOperationMutationDecision =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'resolved' }
  | { readonly kind: 'not-found' };

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
