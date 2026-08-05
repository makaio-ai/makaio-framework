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
   * The settlement neither landed nor was refused on ownership grounds — a raw
   * throw from one of its guarded acts, not a modeled answer. The attempt is
   * torn down on the caller-owned paths: the connector is stopped best-effort,
   * the attempt's tokens are retired as `abandoned`, and the row is committed
   * `dead` — the durable state must not advertise a start whose settlement
   * this process can no longer vouch for.
   */
  | 'settlement-unresolved'
  /** A joined start left the row `starting` more often than the bounded re-read allows. */
  | 'start-unresolved'
  /** Another start won the lead designation and the session still has no agents. */
  | 'lead-conflict';

/** A reserved start that did not end with a usable agent. */
export class SessionStartError extends Error {
  /**
   * The named targets this call could not act for — exactly the set the
   * `agent-unavailable` code refuses. Two producers fill it: a total deferral
   * (every named agent's provider session is held by a generation this runtime
   * does not own) and a stated-target send against a session with no agents
   * (the named agents do not exist). The field deliberately does not separate
   * the two, because the code does not either: which one it was is a statement
   * about the session, carried by the message, not a distinct caller branch —
   * in particular, no entry is guaranteed to be foreign-held-and-retryable.
   *
   * A response field is unreachable on a path that throws, and a send that
   * silently reaches fewer agents than it was asked to is exactly the failure
   * this contract refuses everywhere else. The field carries the set for
   * in-process callers; the message names the agents as well, for anything
   * crossing a transport that may not preserve custom error properties.
   */
  public readonly deferredAgentIds?: readonly string[];

  /**
   * @param code - Which modeled outcome this is; the value callers branch on.
   * @param message - Human-readable detail, including the identifiers involved.
   * @param cause - Underlying failure, when one exists.
   * @param deferredAgentIds - The named targets this call could not act for, when the send named any.
   */
  public constructor(
    public readonly code: SessionStartFailureCode,
    message: string,
    cause?: unknown,
    deferredAgentIds?: readonly string[],
  ) {
    super(message, { cause });
    this.name = 'SessionStartError';
    if (deferredAgentIds !== undefined) this.deferredAgentIds = deferredAgentIds;
  }
}
