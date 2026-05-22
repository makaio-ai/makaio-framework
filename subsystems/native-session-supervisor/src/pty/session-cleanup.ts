/**
 * Session Cleanup Utilities
 *
 * Pure functions for deciding when orphan PTY sessions should be cleaned up.
 * Stateless helpers used by the PTY runtime's background cleanup loop.
 * @packageDocumentation
 */

/** Default timeout before a disconnected session is considered orphaned (5 minutes). */
export const ORPHAN_CLEANUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Interval at which the cleanup loop checks for orphaned sessions (30 seconds). */
export const CLEANUP_INTERVAL_MS = 30 * 1000;

/**
 * Minimal information required to decide whether a session should be cleaned up.
 */
export interface CleanupableSession {
  /** Stable supervisor session identifier used in log messages. */
  supervisorSessionId: string;
  /**
   * Unix epoch timestamp (milliseconds) when the last subscriber disconnected,
   * or `null` when there is at least one active subscriber.
   */
  disconnectedAt: number | null;
  /** Release all internal listeners held by the session. */
  dispose: () => void;
  /** Send a kill signal to the underlying PTY process. */
  kill: () => void;
}

/**
 * Determine whether a disconnected session has exceeded the orphan timeout.
 * @param session - Session to evaluate.
 * @param now - Current Unix epoch timestamp in milliseconds.
 * @param timeoutMs - Milliseconds after which a disconnected session is orphaned.
 *   Defaults to {@link ORPHAN_CLEANUP_TIMEOUT_MS}.
 * @returns `true` if the session should be cleaned up.
 */
export function shouldCleanupSession(
  session: CleanupableSession,
  now: number,
  timeoutMs: number = ORPHAN_CLEANUP_TIMEOUT_MS,
): boolean {
  if (session.disconnectedAt === null) {
    return false;
  }
  const disconnectedFor = now - session.disconnectedAt;
  return disconnectedFor >= timeoutMs;
}

/**
 * Compute how long a session has been disconnected, for use in log messages.
 * @param session - Session to inspect.
 * @param now - Current Unix epoch timestamp in milliseconds.
 * @returns Disconnect duration in whole seconds, or `null` when the session is
 *   still connected.
 */
export function getDisconnectDuration(session: CleanupableSession, now: number): number | null {
  if (session.disconnectedAt === null) {
    return null;
  }
  return Math.round((now - session.disconnectedAt) / 1000);
}
