/**
 * The single decision every agent-recovery path makes: does the replacement
 * connector continue the provider's own conversation, or does it start fresh
 * and receive the stored conversation as injected history?
 *
 * Recovery has always had two consumers of that decision — the
 * `adapter.rehydrateAgent` call (which needs the resume target) and the history
 * assembly that follows it (which needs to know whether history must be
 * injected). Before this module they read two separate values: an optional
 * `resumeAdapterSessionId` on one side and "was this agent recovered?" on the
 * other. They agreed only because no production caller ever set a resume target
 * on a path that also built history. A recovery that resumed natively *and*
 * injected history would replay the whole conversation into a provider session
 * that already holds it.
 *
 * A recovery plan makes the decision an explicit value: produced once, consumed
 * by both sides.
 */

import type { NativeLocalityVerdict } from '@makaio/contracts';

/**
 * Continue the agent's existing provider conversation.
 *
 * The provider still holds the conversation, so history must **not** be
 * injected — the model would see every prior message twice.
 */
export interface NativeResumeRecoveryPlan {
  readonly kind: 'native-resume';
  /** Provider session the replacement connector resumes. */
  readonly resumeAdapterSessionId: string;
}

/**
 * Start a fresh provider session and inject the stored conversation.
 *
 * This is the "warm-fresh" case named in the session-locality design: the agent
 * record survives, but its provider conversation does not — either because the
 * provider session is unreachable (foreign machine, unsupported adapter,
 * unconfirmed movement) or because the agent never had a confirmed one. The
 * caller owns history injection; without it the model starts blank on a session
 * that visibly has prior turns.
 */
export interface FreshWithHistoryRecoveryPlan {
  readonly kind: 'fresh-with-history';
}

/**
 * How one agent regains its conversation when its connector is gone.
 *
 * Produced by {@link planAgentRecovery} (or taken as
 * {@link FRESH_WITH_HISTORY_RECOVERY_PLAN} where no provider session can exist)
 * and read back through {@link recoveryPlanResumeTarget} and
 * {@link recoveryPlanRequiresHistory}, so the rehydrate call and the history
 * routing cannot drift apart.
 */
export type RecoveryPlan = NativeResumeRecoveryPlan | FreshWithHistoryRecoveryPlan;

/**
 * The fresh-with-history plan.
 *
 * Shared frozen instance: the variant carries no per-agent data, and a single
 * instance keeps call sites from implying that it does.
 */
export const FRESH_WITH_HISTORY_RECOVERY_PLAN: FreshWithHistoryRecoveryPlan = Object.freeze({
  kind: 'fresh-with-history',
});

/**
 * Derive the recovery plan for one agent from its locality verdict.
 *
 * Native resume requires both halves of the gate:
 * - the verdict is `native` — this machine owns the provider session store, the
 *   adapter can resume, and the resume currency is intact; and
 * - the agent's own settled currency names a provider session.
 *
 * A native verdict with no resolved currency stays fresh-with-history. The
 * verdict is computed from session-level structural signals, so borrowing
 * another agent's provider session to satisfy it would attach two agents to one
 * provider conversation.
 *
 * **The target is settled currency, not an origin column.** Callers resolve it
 * through `resolveAgentResumeIdentity`, which follows a movement the ownership
 * seam settled onto the agent row; the immutable `adapterSessionId` records only
 * where the conversation started. Passing the raw column here would evaluate the
 * verdict against the currency and then resume the pre-movement session anyway.
 * @param verdict - Native locality verdict evaluated for this agent
 * @param agentAdapterSessionId - Resume currency resolved for this agent, or `undefined` when nothing is resumable
 * @returns Native-resume plan when both halves of the gate hold, fresh-with-history otherwise
 */
export function planAgentRecovery(
  verdict: NativeLocalityVerdict,
  agentAdapterSessionId: string | undefined,
): RecoveryPlan {
  if (verdict.kind !== 'native' || agentAdapterSessionId === undefined) {
    return FRESH_WITH_HISTORY_RECOVERY_PLAN;
  }
  return { kind: 'native-resume', resumeAdapterSessionId: agentAdapterSessionId };
}

/**
 * Resume target the plan hands to `adapter.rehydrateAgent`.
 * @param plan - Recovery plan decided for this agent
 * @returns Provider session to resume, or `undefined` for a fresh replacement connector
 */
export function recoveryPlanResumeTarget(plan: RecoveryPlan): string | undefined {
  return plan.kind === 'native-resume' ? plan.resumeAdapterSessionId : undefined;
}

/**
 * Whether the caller must inject the stored conversation alongside the rehydrate.
 *
 * Exactly the inverse of {@link recoveryPlanResumeTarget} being defined — stated
 * as its own predicate so the history side reads the decision instead of
 * re-deriving it from the absence of a resume target.
 *
 * Declared as a type predicate rather than left to inference: a caller that
 * returns early on history keeps a `native-resume` plan afterwards, and that
 * narrowing is part of what this function promises. Inferring it would make the
 * promise depend on the checker's version rather than on the signature.
 * @param plan - Recovery plan decided for this agent
 * @returns `true` when the replacement connector starts without provider-side history
 */
export function recoveryPlanRequiresHistory(plan: RecoveryPlan): plan is FreshWithHistoryRecoveryPlan {
  return plan.kind === 'fresh-with-history';
}
