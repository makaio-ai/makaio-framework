import type { ExecutionAttemptOutcomeDecision } from '../execution-attempt-outcome.js';

/**
 * Require the successful commit a test fixture is about to explicitly accept.
 * This assertion never turns a conflict or fence into a successful settlement.
 * @param decision - Actual repository commit decision.
 * @returns Accepted or duplicate decision with its canonical outcome facts.
 */
export function requireCommittedOutcome<TOutcome>(
  decision: ExecutionAttemptOutcomeDecision<TOutcome>,
): Extract<ExecutionAttemptOutcomeDecision<TOutcome>, { kind: 'accepted' | 'duplicate' }> {
  if (decision.kind === 'accepted' || decision.kind === 'duplicate') return decision;
  throw new Error(`Expected a committed test outcome, received ${decision.kind}`);
}
