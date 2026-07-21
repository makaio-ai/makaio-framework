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
