/**
 * Slim message routing for the framework SessionOrchestrator.
 *
 * Routes a message to one or more agents using a single shared session context.
 * No per-agent context scoping, no connector swap overlays, no CWD change
 * preferences — those enrichments belong in host-level orchestrators.
 *
 * Hosts that need per-agent context scoping can use the richer routing helpers
 * from `route-to-agents.ts`.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, MessageInput, MakaioSessionAgent, SessionContext } from '@makaio/contracts';
import { HookAbortError } from '@makaio/hooks';
import type { Turn } from '../entities/turn.js';
import type { TurnCompleteCallback } from '../session-turn-manager.js';

/**
 * Route a message to target agents using a single shared session context.
 *
 * Fans out to all agents in parallel. On routing failure, marks the agent
 * as errored and checks for turn completion. On `HookAbortError`, marks
 * the agent as completed with `cancelled` outcome.
 * @param bus - Bus instance for communication
 * @param session - Session metadata (for session ID)
 * @param agents - Target agents to route to
 * @param message - Message content to send
 * @param messageId - Message identifier
 * @param turn - Turn tracking object
 * @param deliveryMode - How to deliver the message to the agent
 * @param onTurnComplete - Callback invoked when the turn completes (all agents done)
 * @param sessionContext - Optional shared session context forwarded to all agents
 */
export async function routeToAgentsCore(
  bus: IMakaioBus,
  session: IMakaioSession,
  agents: MakaioSessionAgent[],
  message: MessageInput,
  messageId: string,
  turn: Turn,
  deliveryMode: 'enqueue' | 'immediate' | undefined,
  onTurnComplete: TurnCompleteCallback,
  sessionContext?: SessionContext,
): Promise<void> {
  const routingPromises = agents.map(async (agent) => {
    try {
      await bus.request(AgentSubjects.sendMessage, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        message,
        deliveryMode,
        messageId,
        turnId: turn.turnId,
        sessionId: session.sessionId,
        sessionContext,
      });

      await bus.emit(SessionSubjects.user_message.acknowledged, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        messageId,
        agentId: agent.agentId,
      });
    } catch (error) {
      if (error instanceof HookAbortError) {
        await bus.emit(SessionSubjects.user_message.completed, {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          turnNumber: turn.turnNumber,
          messageId,
          agentId: agent.agentId,
          outcome: 'cancelled',
        });

        // Concurrent agent completions can each return turnComplete: true, but this
        // is safe — SessionTurnManager.completeTurn has a completingSessions guard
        // that makes all but the first call a no-op.
        const stateChange = turn.markAgentCompleted(agent.agentId);
        if (stateChange.turnComplete) {
          await onTurnComplete(turn, stateChange.result);
        }
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const stateChange = turn.markAgentErrored(agent.agentId, errorMessage);

      await bus.emit(SessionSubjects.user_message.completed, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        messageId,
        agentId: agent.agentId,
        outcome: 'error',
        error: errorMessage,
      });

      if (stateChange.turnComplete) {
        await onTurnComplete(turn, stateChange.result);
      }
    }
  });

  await Promise.all(routingPromises);
}
