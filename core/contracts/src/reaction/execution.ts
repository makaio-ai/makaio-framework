import type { EventFacts } from '../rules/event.js';
import type { RuleSetRef } from '../rules/evaluation.js';
import type { EvaluationId, RuleId } from '../rules/identifiers.js';
import type { ReactionRule } from '../rules/rule.js';

/**
 * Identifier for a single Reaction invocation.
 *
 * Minted by the dispatching runtime for every host dispatch. Invocations are
 * independent: there is no ordering, deduplication, or exactly-once promise
 * attached to this identifier — it exists for logging, outcome correlation,
 * and cancellation bookkeeping only.
 */
export type ReactionInvocationId = string;

/**
 * What caused one part of a rule to run its reaction: the rule, the
 * evaluation and occasion it belongs to, and the effective rule set.
 *
 * The rule is carried whole, including its rule blocks, for reactions that
 * read them.
 */
export interface ReactionCause {
  /** Rule that caused this invocation. */
  readonly ruleId: RuleId;
  /** Evaluation this invocation belongs to. */
  readonly evaluationId: EvaluationId;
  /** Facts of the occasion the rule matched. */
  readonly event: EventFacts;
  /** Rule set in effect for the occasion. */
  readonly ruleSet: RuleSetRef;
  /** The rule itself, including its rule blocks. */
  readonly rule: ReactionRule;
}

/**
 * Frozen execution envelope supplied to a Reaction handler.
 *
 * The runtime captures and freezes the envelope's top-level fields at dispatch
 * time. Every host dispatch has a separate envelope and independent
 * cancellation and deadline controls.
 */
export interface ReactionExecutionContext {
  /** Runtime-minted identifier for this invocation. */
  readonly invocationId: ReactionInvocationId;
  /**
   * Bus correlation identifier propagated from the triggering message, when
   * one exists.
   */
  readonly correlationId: string | undefined;
  /**
   * Runtime-controlled cancellation signal for this invocation.
   *
   * Handlers should pass this to long-running operations so they cancel
   * promptly when the runtime aborts the invocation. Cancellation is
   * cooperative: a handler that resolves after observing the signal still
   * yields the outcome it returns. When cancellation prevents a handler
   * outcome, the dispatcher uses the Reaction's `keyed` property to decide
   * whether evaluation may retry it.
   */
  readonly signal: AbortSignal;
  /**
   * Absolute deadline hint for this invocation as epoch milliseconds, or
   * `undefined` when the host imposed no deadline.
   *
   * An already-expired deadline prevents handler entry. During execution,
   * the dispatcher aborts {@link signal} when it observes that the deadline
   * has passed. Handlers can consult the deadline to budget their own work.
   */
  readonly deadlineEpochMs: number | undefined;
  /**
   * Key of the part this invocation runs:
   * `(ruleId, occasion, location of the element)`. A reaction may refine it;
   * the refined key is what idempotency under `keyed: true` is tracked by.
   */
  readonly key: string;
  /** What caused this invocation to run. */
  readonly cause: ReactionCause;
}
