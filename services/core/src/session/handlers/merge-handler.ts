/**
 * Handler for session.merge RPC.
 *
 * Merges a child session's work back into parent with a handoff summary.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionEventStorageSubjects } from '../session-events/namespace.js';

/**
 * Registers the session.merge RPC handler.
 *
 * Merges a child session's work back into parent with a handoff summary.
 * @param bus - Bus instance for communication
 * @returns Cleanup function to unsubscribe
 */
export function registerMergeHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.merge, async (ctx) => {
    const { parentSessionId, childSessionId, summary } = ctx.payload;
    // Derive a deterministic eventId from the merge identity so retries with the
    // same (parent, child) pair hit onConflictDoNothing instead of inserting
    // duplicate branch.merged rows.
    const eventId = `merge:${parentSessionId}:${childSessionId}`;

    // 1. Validate parent exists and is active
    const { session: parentSession } = await bus.request(SessionSubjects.get, {
      sessionId: parentSessionId,
    });

    if (!parentSession) {
      throw new Error(`[merge-handler] Parent session not found: ${parentSessionId}`);
    }

    if (parentSession.status !== 'active') {
      throw new Error(`[merge-handler] Parent session is not active: ${parentSessionId}`);
    }

    // 2. Validate child exists
    const { session: childSession } = await bus.request(SessionSubjects.get, {
      sessionId: childSessionId,
    });

    if (!childSession) {
      throw new Error(`[merge-handler] Child session not found: ${childSessionId}`);
    }

    // 3. Validate parent-child relationship
    if (childSession.parentSessionId !== parentSessionId) {
      throw new Error(
        `[merge-handler] Invalid parent-child relationship: session ${childSessionId} is not a child of ${parentSessionId}` +
          (childSession.parentSessionId
            ? ` (actual parent: ${childSession.parentSessionId})`
            : ' (session has no parent)'),
      );
    }

    // 4. Emit merging event (extensions can contribute)
    await bus.emit(SessionSubjects.merging, {
      parentSessionId,
      childSessionId,
    });

    // 5. Generate handoff (use provided summary or generate)
    const handoff = summary ?? `Child session ${childSessionId} merged.`;

    // 6. Close child session
    // close is intentionally idempotent. When child is already closed, this still returns success
    // without re-emitting session.closed; merge only depends on persisted closed state.
    const closeResult = await bus.request(SessionSubjects.close, {
      sessionId: childSessionId,
    });

    if (!closeResult.success) {
      throw new Error(`[merge-handler] Failed to close child session: ${childSessionId}`);
    }

    // Trust level of `handoff` depends on `ctx.payload.source`:
    //   - source === 'system':  programmatic, not user content
    //   - source === 'user':    caller-supplied free text
    //   - source === 'extension':  extension-supplied content
    //   - source absent:        unknown trust when summary is provided;
    //                            auto-generated fallback when summary is absent
    // The bypass below is correct regardless: SessionLogger's transform scope
    // covers conversation messages (turn payloads), not structural branch-lifecycle
    // records. If future redaction needs extend to merge summaries, the transform
    // must be applied to `handoff` before resultJson is built.
    const resultJson = JSON.stringify({ handoff });

    // 7. Persist branch.merged event directly before the bus emit.
    // Owning persistence here (rather than delegating to a SessionLogger subscriber)
    // means: (a) the deterministic eventId prevents duplicate branch.merged rows
    // while still allowing append-time metadata backfill on conflict, and (b) a
    // subscriber throw can no longer duplicate the audit record.
    await bus.request(SessionEventStorageSubjects.append, {
      event: {
        sessionId: parentSessionId,
        eventId,
        timestamp: Date.now(),
        type: 'branch.merged',
        payload: {
          childSessionId,
          parentSessionId,
          resultJson,
        },
      },
    });

    // 8. Emit branch lifecycle event for remaining observers (e.g. UI updates).
    // Persistence is already done above; this emit is observer-only.
    await bus.emit(SessionSubjects.branch.merged, {
      sessionId: parentSessionId,
      childSessionId,
      parentSessionId,
      resultJson,
    });

    // 9. Emit merged event
    await bus.emit(SessionSubjects.merged, {
      parentSessionId,
      childSessionId,
      handoff,
    });

    ctx.setResult({
      success: true,
      handoff,
    });
  });
}
