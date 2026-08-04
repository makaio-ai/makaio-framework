import type { IMakaioBus } from '@makaio/bus-core';
import { type IMakaioSession, type SessionContext } from '@makaio/contracts';
import { getFullConversation } from '../context/get-full-conversation.js';
import { convertSessionMessage } from '../context/convert-session-message.js';
import { recoveryPlanRequiresHistory, type RecoveryPlan } from '../recovery-plan.js';

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

/**
 * Build the session context a recovery plan calls for.
 *
 * This is the history half of the recovery contract: it consumes the same
 * {@link RecoveryPlan} the rehydrate call consumes, so a natively resumed agent
 * can never also be handed the conversation the provider already holds, and a
 * fresh-with-history agent can never start blank.
 * @param bus - Bus instance
 * @param session - Session whose conversation is projected
 * @param plan - Recovery plan decided for the agents being recovered
 * @returns Full-history context for a fresh-with-history plan, `undefined` for native resume
 */
export async function buildPlannedRecoveryContext(
  bus: IMakaioBus,
  session: IMakaioSession,
  plan: RecoveryPlan,
): Promise<SessionContext | undefined> {
  if (!recoveryPlanRequiresHistory(plan)) return undefined;
  return buildRecoveryContext(bus, session);
}
