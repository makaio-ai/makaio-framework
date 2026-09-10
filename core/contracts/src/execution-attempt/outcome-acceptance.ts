import type { z } from 'zod';
import type { ExecutionAttemptCancellationIntentSchema } from './control.js';

/** A durable request to stop an attempt, never evidence that it stopped. */
export type ExecutionAttemptCancellationIntent = Readonly<z.infer<typeof ExecutionAttemptCancellationIntentSchema>>;

/** Accepted control facts observed atomically with the first canonical outcome commit. */
export interface AttemptOutcomeControlObservation {
  /** Zero before Cancel; the winning request revision afterwards. */
  readonly controlRevision: number;
  /** Detached winning receipt, or null when no Cancel had been accepted. */
  readonly cancellation: ExecutionAttemptCancellationIntent | null;
}

/** Owner interpretation of a technical fact, independent of proof that its worker stopped. */
export type OutcomeAcceptance = 'projected' | 'recorded-only';

/** Canonical outcome and its explicit owner interpretation delivered to local consumers. */
export interface AcceptedAttemptOutcome<TOutcome> {
  /** Original committed outcome; recorded-only acceptance never rewrites this value. */
  readonly outcome: TOutcome;
  /** Frozen commit-time observation, or unknown for legacy outcomes. */
  readonly controlObservation: AttemptOutcomeControlObservation | null;
  /** Whether this outcome may be projected onto the owner's lifecycle. */
  readonly acceptance: OutcomeAcceptance;
}
