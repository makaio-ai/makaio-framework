import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';

/**
 * Linearizes session close requests with agent-attach commit points.
 *
 * A close claim begins synchronously before the canonical close handler awaits
 * storage. Attach may commit only while no close request owns the session.
 */
export class SessionAttachCloseGate {
  private readonly closeClaims = new Map<string, number>();

  /**
   * Register middleware that owns a close claim for the whole request chain.
   * @param bus - Bus whose close requests must be observed.
   * @returns Cleanup function for the middleware registration.
   */
  public registerCloseMiddleware(bus: IMakaioBus): () => void {
    return bus.on(
      SessionSubjects.close,
      async (context) => {
        const release = this.beginClose(context.payload.sessionId);
        try {
          await context.next();
        } finally {
          release();
        }
      },
      { priority: 10_000 },
    );
  }

  /**
   * Reject an attach commit when closing has already claimed the session.
   * @param sessionId - Session whose attach is about to become observable.
   */
  public assertAttachCommitAllowed(sessionId: string): void {
    if ((this.closeClaims.get(sessionId) ?? 0) > 0) {
      throw new Error(`[attach-handler] Session close won before agent attach committed: ${sessionId}`);
    }
  }

  /**
   * Claim a session for one in-flight close request.
   * @param sessionId - Session being closed.
   * @returns Idempotent claim release.
   */
  private beginClose(sessionId: string): () => void {
    this.closeClaims.set(sessionId, (this.closeClaims.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.closeClaims.get(sessionId) ?? 1) - 1;
      if (remaining === 0) this.closeClaims.delete(sessionId);
      else this.closeClaims.set(sessionId, remaining);
    };
  }
}
