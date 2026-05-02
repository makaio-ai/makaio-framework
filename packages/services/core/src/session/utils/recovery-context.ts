import type { IMakaioBus } from '@makaio/bus-core';
import { type IMakaioSession, type SessionContext } from '@makaio/contracts';
import { getFullConversation } from '../context/get-full-conversation.js';
import { convertSessionMessage } from '../context/convert-session-message.js';

/**
 * Build sessionContext with messageHistory for a recovered agent.
 * Uses getFullConversation() to assemble history from stored messages.
 *
 * This function is framework-safe: it has no host-layer dependencies
 * (no PersonaSubjects, ProfileSubjects, VirtualModelSubjects, etc.).
 * @param bus - Bus instance
 * @param session - Session to build context for
 * @returns SessionContext with messageHistory and isFirstTurn signal
 */
export async function buildRecoveryContext(bus: IMakaioBus, session: IMakaioSession): Promise<SessionContext> {
  const contextResult = await getFullConversation(bus, session.sessionId);
  const messageHistory = contextResult.messages.map(convertSessionMessage);

  return {
    messageHistory,
    isFirstTurn: true, // Force fresh mode — new agent has no native history
  };
}
