/**
 * The callers waiting for an ACP session ID that does not exist yet.
 *
 * A connector's session ID is established by a handshake, so a caller can ask
 * for it before there is one. The wait is **event-driven**: there is exactly one
 * statement in the connector that establishes a session ID, so the waiters are
 * released from it. Polling for a value whose single assignment is in the same
 * object meant a 50ms interval per waiter, a timer to clear on every exit path,
 * and a wait that answered up to a poll late — all of it to observe something the
 * connector could simply announce.
 *
 * They stay owned by one object with a single release path rather than an array
 * the connector rewrites in three places.
 * @packageDocumentation
 */
import { DeferredPromise } from '@makaio/utils';

/** Failure every waiter receives when its connector terminates first. */
const TERMINATED_BEFORE_SESSION_ID = 'Connector terminated before session ID was established';

/**
 * Callers waiting for an ACP session ID, and the one place they are released.
 *
 * Every waiter leaves through {@link resolveAll} or {@link rejectAll}, and both
 * take the pending set before settling anything, so a waiter can never be settled
 * twice and the set can never hold one that already was.
 */
export class SessionIdWaiters {
  private waiters: DeferredPromise<string>[] = [];

  /**
   * Wait for a session ID to be established, or for the connector to terminate.
   *
   * Registers unconditionally: the caller owns the "already established" fast path,
   * because it is the one holding the field and can answer without a promise at all.
   * @returns The session ID once established.
   */
  public wait(): Promise<string> {
    const waiter = new DeferredPromise<string>();
    this.waiters.push(waiter);
    return waiter.getPromise();
  }

  /**
   * Hand every waiter the session ID the connector just established.
   *
   * Must be called from the statement that establishes it, with no await in
   * between: a waiter that registers after the field is set takes the caller's
   * fast path, and one that registered before is in this set — the two cover every
   * arrival only while nothing can interleave between them.
   * @param sessionId - Session ID the handshake established.
   */
  public resolveAll(sessionId: string): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.resolve(sessionId);
  }

  /**
   * Fail every waiter because the connector will never establish a session.
   * @param error - Failure to hand to the waiters; defaults to termination.
   */
  public rejectAll(error: Error = new Error(TERMINATED_BEFORE_SESSION_ID)): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) waiter.reject(error);
  }

  /**
   * Failure a caller receives when it asks after the connector has terminated.
   * @returns The termination failure, shaped like the one waiters receive.
   */
  public static terminatedError(): Error {
    return new Error(TERMINATED_BEFORE_SESSION_ID);
  }
}
