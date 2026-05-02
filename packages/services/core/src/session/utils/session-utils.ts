import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession, type MakaioSessionAgent, type SessionContext } from '@makaio/contracts';
import { Turn } from '../entities/turn.js';

/**
 * Get existing session or create a new one.
 * @param bus - Makaio bus instance
 * @param providedSessionId - Session ID to look up
 * @param _sessionContext - Optional session context (scope fields removed in W1-A)
 * @param originWindowId - Window ID that initiated the session creation
 * @returns Session ID and session object
 */
export async function getOrCreateSession(
  bus: IMakaioBus,
  providedSessionId: string,
  _sessionContext?: SessionContext,
  originWindowId?: string,
): Promise<{ sessionId: string; session: IMakaioSession }> {
  const { session } = await bus.request(SessionSubjects.get, { sessionId: providedSessionId });
  if (session) {
    if (session.status !== 'active') {
      throw new Error(`[getOrCreateSession] Session is not active: ${providedSessionId}`);
    }
    return { sessionId: providedSessionId, session };
  }

  await bus.request(SessionSubjects.create, {
    sessionId: providedSessionId,
    originWindowId,
  });
  const { session: created } = await bus.request(SessionSubjects.get, { sessionId: providedSessionId });
  if (!created) {
    throw new Error(`[getOrCreateSession] Failed to create session: ${providedSessionId}`);
  }
  return { sessionId: providedSessionId, session: created };
}

/**
 * Resolve which agents to target based on the request.
 * @param session - The session containing agents
 * @param targetSpec - Target: undefined (lead agent), 'all', or specific agent IDs
 * @returns Resolved target agents
 */
export function resolveTargetAgents(
  session: IMakaioSession,
  targetSpec: string[] | 'all' | undefined,
): MakaioSessionAgent[] {
  if (targetSpec === undefined) {
    const leadAgent = session.agents.find((a) => a.agentId === session.leadAgentId);
    if (!leadAgent) {
      throw new Error(`[resolveTargetAgents] Lead agent not found: ${session.leadAgentId}`);
    }
    return [leadAgent];
  }

  if (targetSpec === 'all') {
    return session.agents;
  }
  const agentSet = new Set(targetSpec);
  return session.agents.filter((a) => agentSet.has(a.agentId));
}

/**
 * Find which turn an agent belongs to.
 * @param activeTurns - Active turns map
 * @param agentId - The agent ID to look up
 * @returns The turn containing this agent, or undefined
 */
export function findTurnByAgent(activeTurns: Map<string, Turn>, agentId: string): Turn | undefined {
  for (const turn of activeTurns.values()) {
    if (turn.hasAgent(agentId)) {
      return turn;
    }
  }
  return undefined;
}
