import type { IMakaioBus, InterceptorContext } from '@makaio/bus-core';
import type { SessionSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import type { PostTurnContext } from '../types/hook-context.js';
import { fetchSessionEnrichment } from './session-enrichment.js';

/** Session-level turn.completed payload */
type SessionTurnCompleted = ExtractSubjectPayload<typeof SessionSubjects.turn.completed>;

/**
 * Build PostTurn context from interceptor context.
 *
 * Extracts turn completion data and provides a clean API for hooks.
 * Enriches with session, recentHistory, and project when available.
 * @param rawCtx - Interceptor context from turn.completed event
 * @param bus - Bus instance for making requests
 * @returns PostTurnContext for hook handlers
 */
export async function buildPostTurnContext(
  rawCtx: InterceptorContext<SessionTurnCompleted>,
  bus: IMakaioBus,
): Promise<PostTurnContext> {
  const payload = rawCtx.payload;

  // Enrich with session data (uses sessionId from turn.completed payload)
  const enriched = await fetchSessionEnrichment(bus, payload.sessionId);

  return {
    ...enriched.contextExtensions,
    hookEvent: 'PostTurn',
    // Convenience accessors
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    success: payload.success,
    error: payload.error,
    // Full payload for advanced use
    payload,
    // Correlation
    messageId: rawCtx.messageId,
    correlationId: rawCtx.correlationId,
    // Session enrichment (from SessionHookContext)
    session: enriched.session,
    recentHistory: enriched.recentHistory,
    contextExtensions: enriched.contextExtensions,
    bus,
    // Interceptor controls
    async next() {
      await rawCtx.next();
    },
    stopPropagation: rawCtx.stopPropagation.bind(rawCtx),
  };
}
