/**
 * Seed a non-native attach session context with projected conversation history.
 *
 * When the locality verdict degrades from native resume (any non-native path),
 * the adapter starts a fresh provider session. Without injected history the
 * model context would be empty even though the session has prior conversation.
 *
 * This module loads the full projected conversation via
 * {@link getFullConversation} and attaches it as `messageHistory` with
 * `isFirstTurn: true`, matching the seeding idiom used by route-to-agents
 * (native fallback) and assemble-fork-context (non-native fork).
 *
 * DRY note: three sites now build fresh-with-history contexts:
 * - route-to-agents `buildNativeFallbackContext` — filters current messageId
 *   because a user message is in flight and must not also appear in history.
 * - assemble-fork-context `buildFreshWithHistory` — adds `hasNewTransforms`
 *   from fork session transforms.
 * - this function — plain session, no in-flight message, no transforms.
 *
 * Each site adds 1-2 site-specific fields on top of the shared
 * getFullConversation + convertSessionMessage core. A shared parameterized
 * helper would need optional message filter, optional hasNewTransforms, and
 * optional empty-array elision — forced abstraction for three ~5-line callers.
 * Keeping them local is clearer.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionContext } from '@makaio/contracts';
import { getFullConversation } from './get-full-conversation.js';
import { convertSessionMessage } from './convert-session-message.js';

/**
 * Enrich a non-native attach session context with the session's conversation.
 *
 * When the session has no messages, the context is returned unchanged — omitting
 * an empty `messageHistory` field matches the convention where the field is
 * absent for genuinely empty sessions.
 * @param bus - Bus instance for conversation retrieval
 * @param sessionId - Session whose history to project
 * @param context - Non-native session context to seed (must be defined)
 * @returns Session context enriched with messageHistory when history exists
 */
export async function seedAttachContextWithHistory(
  bus: IMakaioBus,
  sessionId: string,
  context: SessionContext,
): Promise<SessionContext> {
  const contextResult = await getFullConversation(bus, sessionId);
  if (contextResult.messages.length === 0) {
    return context;
  }
  const messageHistory = contextResult.messages.map(convertSessionMessage);
  return {
    ...context,
    messageHistory,
    isFirstTurn: true,
  };
}
