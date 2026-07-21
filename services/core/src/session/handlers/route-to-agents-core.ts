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
import { AgentSubjects } from '@makaio/contracts';
import type { IMakaioSession, MessageInput, ResponseSchemaDescriptor, SessionContext } from '@makaio/contracts';
import { getHookAbortError } from './hook-abort-error.js';
import { emitRoutingAcknowledged, terminalizeRoutingAgent } from './routing-lifecycle.js';
import type { Turn } from '../entities/turn.js';
import type { TurnCompleteCallback } from '../turn-completion.js';
import type { TurnCompletionRecorder } from './routing-lifecycle.js';

/** Durable result of one agent's core-routing dispatch attempt. */
export type AgentDispatchOutcome =
  | { readonly agentId: string; readonly kind: 'dispatched' }
  | { readonly agentId: string; readonly kind: 'cancelled'; readonly error: unknown }
  | { readonly agentId: string; readonly kind: 'failed'; readonly error: unknown };

/**
 * Route a message to target agents using a single shared session context.
 *
 * Fans out to all agents in parallel. On routing failure, marks the agent
 * as errored and checks for turn completion. On `HookAbortError`, marks
 * the agent as completed with `cancelled` outcome.
 *
 * Contract: `sessionContext` must not carry a `nativeFork` directive. This
 * function dispatches exclusively via `agent.sendMessage`, which never
 * consumes the directive — fork directives are consumed only on the
 * `startAgent` path. Callers assembling fork contexts must degrade them to
 * fresh-with-history first (see `routeToAgents`).
 * @param bus - Bus instance for communication
 * @param session - Session metadata (for session ID)
 * @param agents - Target agents to route to
 * @param message - Message content to send
 * @param messageId - Message identifier
 * @param turn - Turn tracking object
 * @param deliveryMode - How to deliver the message to the agent
 * @param onTurnComplete - Callback invoked when the turn completes (all agents done)
 * @param turnManager - Required ledger owner for direct terminal outcomes
 * @param sessionContext - Optional shared session context forwarded to all agents
 * @param responseSchema - Optional structured output descriptor for the turn
 * @param assertDispatch - Optional synchronous authority check at the provider-dispatch linearization point
 * @returns Durable dispatch outcomes after direct routing failures terminalize.
 */
export async function routeToAgentsCore(
  bus: IMakaioBus,
  session: IMakaioSession,
  agents: ReadonlyArray<{ agentId: string; adapterId: string }>,
  message: MessageInput,
  messageId: string,
  turn: Turn,
  deliveryMode: 'enqueue' | 'immediate' | undefined,
  onTurnComplete: TurnCompleteCallback,
  turnManager: TurnCompletionRecorder,
  sessionContext?: SessionContext,
  responseSchema?: ResponseSchemaDescriptor,
  assertDispatch?: () => void,
): Promise<readonly AgentDispatchOutcome[]> {
  // The caller admitted this fanout before routing. Verify the whole set before
  // the first provider await so a direct failure can never leave an untracked pair.
  if (agents.some((agent) => !turn.hasAdmittedPair(messageId, agent.agentId))) {
    throw new Error(`Turn ${turn.turnId} has no admitted fanout for message ${messageId}`);
  }
  const routingPromises: Array<Promise<AgentDispatchOutcome>> = agents.map(async (agent) => {
    try {
      assertDispatch?.();
      await bus.request(AgentSubjects.sendMessage, {
        agentId: agent.agentId,
        adapterId: agent.adapterId,
        message,
        deliveryMode,
        messageId,
        turnId: turn.turnId,
        sessionId: session.sessionId,
        sessionContext,
        ...(responseSchema !== undefined && { responseSchema }),
      });

      await emitRoutingAcknowledged(bus, {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        messageId,
        agentId: agent.agentId,
      });
      return { agentId: agent.agentId, kind: 'dispatched' } satisfies AgentDispatchOutcome;
    } catch (error) {
      if (getHookAbortError(error) !== undefined) {
        await terminalizeRoutingAgent({
          bus,
          turn,
          messageId,
          agentId: agent.agentId,
          outcome: 'cancelled',
          onTurnComplete,
          turnManager,
        });
        return { agentId: agent.agentId, kind: 'cancelled', error } satisfies AgentDispatchOutcome;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      await terminalizeRoutingAgent({
        bus,
        turn,
        messageId,
        agentId: agent.agentId,
        outcome: 'error',
        error: errorMessage,
        onTurnComplete,
        turnManager,
      });
      return { agentId: agent.agentId, kind: 'failed', error } satisfies AgentDispatchOutcome;
    }
  });

  return await Promise.all(routingPromises);
}
