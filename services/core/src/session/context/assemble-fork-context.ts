import type { IMakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, SessionContext } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turns/index.js';
import { getFullConversation } from './get-full-conversation.js';
import { convertSessionMessage } from './convert-session-message.js';

/**
 * Assemble fork context for a session's first turn.
 *
 * For fork sessions on their first turn, this:
 * 1. Detects if this is a fork session (has parentSessionId)
 * 2. Checks if this is the first turn (via isNewTurn flag + storage query)
 * 3. Calls getFullConversation() to get projected context with transforms
 * 4. Converts SessionMessage[] to Message[] format
 * 5. Returns enriched SessionContext with messageHistory
 *
 * If not a fork first turn, returns the original sessionContext unchanged.
 * @param bus - Bus instance for RPC calls
 * @param session - Session to check for fork context
 * @param sessionId - Session ID
 * @param originalContext - Original sessionContext from payload
 * @param isNewTurn - Whether this is a new turn (avoids race with just-created turn record)
 * @returns Enriched or original SessionContext
 */
export async function assembleForkContext(
  bus: IMakaioBus,
  session: IMakaioSession,
  sessionId: string,
  originalContext?: SessionContext,
  isNewTurn?: boolean,
): Promise<SessionContext | undefined> {
  const shouldInheritParentHistory =
    session.parentSessionId !== undefined &&
    (session.contextInheritance === 'parent-history' ||
      (session.contextInheritance === undefined && session.branchKind !== 'subagent'));

  // Skip if this child does not inherit parent history or context already has messageHistory.
  if (!shouldInheritParentHistory || originalContext?.messageHistory) {
    return originalContext;
  }

  // Determine if this is the first turn.
  // Use isNewTurn flag combined with storage query to distinguish
  // "just the one we created" from "had prior turns".
  const { turns } = await bus.request(TurnStorageSubjects.getBySession, {
    sessionId,
    limit: 2,
  });
  const isFirstTurn = !!isNewTurn && turns.length <= 1;

  if (!isFirstTurn) {
    return originalContext;
  }

  // Assemble projected context with transforms
  const contextResult = await getFullConversation(bus, sessionId);

  // Convert SessionMessage[] to Message[] for sessionContext
  const messageHistory = contextResult.messages.map(convertSessionMessage);

  return {
    ...originalContext,
    messageHistory,
    isFirstTurn: true,
    hasNewTransforms: session.forkTransforms !== undefined,
  };
}
