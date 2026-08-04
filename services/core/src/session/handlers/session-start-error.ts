/**
 * Why a reserved start could not be completed, as a value the caller can branch
 * on.
 *
 * Every member names a *modeled* outcome of the ownership seam, not a bug: a
 * start that reaches a live connector can still be refused ownership of what
 * that connector is talking to, and the caller has to be told which of those
 * happened rather than being handed a message to match on.
 */
export type SessionStartFailureCode =
  /** The adapter refused or threw; the reservation was rolled back or retired. */
  | 'start-failed'
  /**
   * The connector is live but another generation owns the provider session it
   * speaks to. The connector was stopped and the claims retired.
   */
  | 'ownership-refused'
  /** The agent row is `disposed` or gone; the connector was stopped. */
  | 'agent-unavailable'
  /**
   * The settlement neither landed nor was refused on ownership grounds. Nothing
   * is torn down — the row stays `starting` for the next send to resolve.
   */
  | 'settlement-unresolved'
  /**
   * Another runtime claimed this start's recovery while it was in flight, so its
   * completion has no row left to write. The claims were abandoned and the
   * connector stopped.
   */
  | 'start-lost'
  /** A joined start left the row `starting` more often than the bounded re-read allows. */
  | 'start-unresolved'
  /** Another start won the lead designation and the session still has no agents. */
  | 'lead-conflict';

/** A reserved start that did not end with a usable agent. */
export class SessionStartError extends Error {
  /**
   * @param code - Which modeled outcome this is; the value callers branch on.
   * @param message - Human-readable detail, including the identifiers involved.
   * @param cause - Underlying failure, when one exists.
   */
  public constructor(
    public readonly code: SessionStartFailureCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'SessionStartError';
  }
}
