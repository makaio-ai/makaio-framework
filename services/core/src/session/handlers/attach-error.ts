import type { AdapterStartDisposition } from '@makaio/contracts';

/**
 * A reserved attach that did not end with an agent this runtime may drive.
 *
 * Separate from {@link SessionAgentAttachError}, which says *which stage* failed:
 * this says what the failure is evidence *of*, and the rollback branches on it.
 */
export class AttachStartError extends Error {
  /**
   * @param code - Which gate refused. Machine-readable so a caller can retry a
   *   `lead-conflict` from a fresh session read without string-matching.
   * @param message - Human-readable detail, including the identifiers involved.
   * @param dispatch - How far the failed start got, as the rollback's evidence.
   *
   *   **Every pre-dispatch refusal carries `'not-dispatched'`, explicitly:**
   *   `lead-conflict`, `agent-disposed`, `not-found`, and a reservation that
   *   threw. All four fire before `adapter.startAgent` is called, so the
   *   rollback must take the deleting branch — leaving the disposition to a
   *   default would silently strand a row and a key for a start that never
   *   reached a provider.
   * @param options - Underlying failure, when one exists.
   * @param sessionStatus - Stored non-active session status observed by a refused reservation.
   */
  public constructor(
    public readonly code: 'lead-conflict' | 'reservation-refused' | 'session-not-active' | 'start-failed',
    message: string,
    public readonly dispatch: AdapterStartDisposition,
    options?: ErrorOptions,
    public readonly sessionStatus?: 'closed' | 'archived' | 'discovered',
  ) {
    super(message, options);
    this.name = 'AttachStartError';
  }
}

/** Stage-specific failure from the atomic session-agent attach operation. */
export class SessionAgentAttachError extends Error {
  /**
   * @param stage - Attach stage that rejected.
   * @param cause - Original stage failure.
   */
  public constructor(
    public readonly stage: 'agent_attach' | 'initial_message',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SessionAgentAttachError';
  }
}

/**
 * Find an attach failure through bus request error wrappers.
 * @param error - Error or wrapper chain to inspect.
 * @returns The stage-specific attach failure, when present.
 */
export function getSessionAgentAttachError(error: unknown): SessionAgentAttachError | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof SessionAgentAttachError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
