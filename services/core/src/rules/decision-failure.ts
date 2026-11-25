import type { GroupEvaluationView } from '@makaio/contracts/rules';

/** Decision failures with durable reason codes. */
export type DecisionFailureReason =
  | 'contribution-unavailable'
  | 'decision-timeout'
  | 'lookup-args-invalid'
  | 'lookup-answer-invalid'
  | 'strategy-failed'
  | 'strategy-invalid';

/** A read-only decision could not proceed at its current stage. */
export class DecisionFailure extends Error {
  /** @param reason - Durable code describing the failed decision stage. */
  public constructor(public readonly reason: DecisionFailureReason) {
    super(reason);
  }
}

/** Internal group envelope with a durable count of expired attempts. */
export interface StoredDecisionGroup extends GroupEvaluationView {
  /** Timeouts for this group's decision, independent of availability retries. */
  readonly timeoutAttempts?: number;
}
