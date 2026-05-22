/**
 * Handler for session.abandon RPC.
 *
 * Abandons a child session without merging (no handoff).
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';

/**
 * Registers the session.abandon RPC handler.
 *
 * Abandons a child session without merging (no handoff).
 * @param bus - Bus instance for communication
 * @returns Cleanup function to unsubscribe
 */
export function registerAbandonHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.abandon, async (ctx) => {
    const { parentSessionId, childSessionId } = ctx.payload;

    // 1. Validate child exists
    const { session: childSession } = await bus.request(SessionSubjects.get, {
      sessionId: childSessionId,
    });

    if (!childSession) {
      throw new Error(`[abandon-handler] Child session not found: ${childSessionId}`);
    }

    // 2. Validate parent-child relationship
    if (childSession.parentSessionId !== parentSessionId) {
      throw new Error(
        `[abandon-handler] Invalid parent-child relationship: session ${childSessionId} is not a child of ${parentSessionId}` +
          (childSession.parentSessionId
            ? ` (actual parent: ${childSession.parentSessionId})`
            : ' (session has no parent)'),
      );
    }

    // 3. Close child session
    // close is intentionally idempotent. Already-closed children return success,
    // and abandon relies on closed state rather than duplicate session.closed events.
    const closeResult = await bus.request(SessionSubjects.close, {
      sessionId: childSessionId,
    });

    if (!closeResult.success) {
      throw new Error(`[abandon-handler] Failed to close child session: ${childSessionId}`);
    }

    // 4. Emit abandoned event
    await bus.emit(SessionSubjects.abandoned, {
      sessionId: childSessionId,
      parentSessionId,
    });

    ctx.setResult({ success: true });
  });
}
