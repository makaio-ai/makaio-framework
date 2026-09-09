import type { AttemptOutcomeControlObservation } from './execution-attempt-cancellation.js';
import type { RuntimeOutcomeFence } from './execution-attempt-decisions.js';
import type { DurableOutcome, ExecutionOwnerId } from './execution-attempt-repository.js';

/**
 * Input for committing a terminal outcome to an attempt.
 *
 * The repository makes the durable accept/duplicate/conflict/fence decision
 * and returns the canonical outcome for convergence. Outcome commitment
 * carries no claim: a worker's answer never depends on who currently owns
 * the attempt's provider operation.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export interface ExecutionAttemptOutcomeCommit<TOutcome> {
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Owner identifier the attempt belongs to. */
  readonly executionId: ExecutionOwnerId;
  /**
   * The rendering produced by the repository's canonicalizeOutcome method.
   *
   * A rendering rather than a raw outcome so the value a caller validated and
   * the value that becomes durable are the same one: the caller renders the
   * submission once and never reads its own object again.
   */
  readonly result: DurableOutcome<TOutcome>;
  /** Runtime correlation checked atomically for a fresh commit; owner-only paths may omit it. */
  readonly runtimeFence?: RuntimeOutcomeFence;
}

/**
 * Durable decision returned by the repository's commitOutcome method.
 *
 * - `accepted`: the outcome was committed as canonical for the first time.
 *   The stored text decoded is reported, never the caller's copy of it.
 * - `duplicate`: a canonically equal outcome was submitted again; this is a
 *   replay. The committed outcome is reported, never the caller's copy of it.
 * - `conflict`: the attempt already reached a different terminal state — either
 *   a different committed outcome, or a competing terminal transition that
 *   settled it without one.
 * - `fenced`: the attempt is no longer the active attempt for this execution.
 *
 * Both settling kinds carry `text`: the durable text the attempt holds for
 * this outcome. For `accepted` that is the text the commit just wrote; for
 * `duplicate` it is the text the earlier commit wrote, which is not
 * necessarily the retry's own rendering — canonical equality ignores member
 * order and other differences a codec may render between identical values.
 * A caller needing a copy nobody else has held decodes this committed text
 * through the repository's decodeOutcome method. Decoding its own submission
 * instead would hand out the retry's representation rather than the committed one.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
export type ExecutionAttemptOutcomeDecision<TOutcome> =
  | {
      readonly kind: 'accepted';
      readonly outcome: TOutcome;
      readonly text: string;
      /** Frozen at first commit; null only for outcomes predating control observation. */
      readonly controlObservation: AttemptOutcomeControlObservation | null;
    }
  | {
      readonly kind: 'duplicate';
      readonly outcome: TOutcome;
      readonly text: string;
      /** The original observation, never the control state at retry time. */
      readonly controlObservation: AttemptOutcomeControlObservation | null;
    }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'fenced' };
