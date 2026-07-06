/**
 * Initial-message turn tracking for session.agent.attach.
 *
 * The attach flow starts an adapter agent before it can persist the initial
 * user message. These helpers keep the rollback contract local to that seam.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import type { MessageInput, StartAgentResponse } from '@makaio/contracts';
import { Turn } from '../entities/turn.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { emitSessionTurnStarted } from '../session-lifecycle-events.js';
import { extractTextContent, normalizeToBlocks } from '../session-orchestrator-helpers.js';
import { TurnStorageSubjects } from '../turns/index.js';

/**
 * Set up initial-message turn tracking and stop the started agent if setup fails.
 * @param bus - Bus instance for storage and adapter rollback
 * @param activeTurns - Shared turn state map
 * @param startResult - Successful adapter startup result
 * @param sessionId - Target session ID
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 * @returns Turn tracking info
 */
export async function setupTurnTrackingOrRollbackAgent(
  bus: IMakaioBus,
  activeTurns: Map<string, Turn>,
  startResult: Extract<StartAgentResponse, { success: true }>,
  sessionId: string,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<{ messageId: string; turnId: string }> {
  try {
    return await setupTurnTracking(bus, activeTurns, sessionId, agentId, messageId, content);
  } catch (error) {
    console.error('[attach-handler] Failed to set up initial-message turn, rolling back started agent', {
      sessionId,
      agentId,
      adapterId: startResult.adapterId,
      error,
    });
    await stopStartedAgentAfterFailure(bus, startResult, sessionId, 'initial-message turn setup failure');
    throw error;
  }
}

/**
 * Stop a successfully started adapter agent after a later attach step fails.
 * @param bus - Bus instance for adapter RPC
 * @param startResult - Successful adapter startup result
 * @param sessionId - Session being attached
 * @param reason - Human-readable rollback reason for diagnostics
 */
export async function stopStartedAgentAfterFailure(
  bus: IMakaioBus,
  startResult: Pick<Extract<StartAgentResponse, { success: true }>, 'adapterId' | 'agentId'>,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await bus.request(AdapterSubjects.stopAgent, {
      adapterId: startResult.adapterId,
      agentId: startResult.agentId,
    });
  } catch (stopError) {
    console.error(`[attach-handler] Failed to rollback started agent after ${reason}`, {
      sessionId,
      agentId: startResult.agentId,
      adapterId: startResult.adapterId,
      error: stopError,
    });
  }
}

/**
 * Sets up turn tracking and emits turn/message events.
 *
 * Persists the turn via storage to obtain a monotonic `turnNumber` before
 * emitting lifecycle events (which include `turnNumber` in their schema).
 * @param bus - Bus instance for event emission and storage
 * @param activeTurns - Shared turn state map
 * @param sessionId - Target session ID
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 * @returns Turn tracking info
 */
async function setupTurnTracking(
  bus: IMakaioBus,
  activeTurns: Map<string, Turn>,
  sessionId: string,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<{ messageId: string; turnId: string }> {
  const { turn: storedTurn } = await bus.request(TurnStorageSubjects.create, { sessionId });
  const turn = new Turn({
    sessionId,
    agentIds: [agentId],
    turnId: storedTurn.turnId,
    turnNumber: storedTurn.turnNumber,
  });

  try {
    await bus.requestOptional(MessageStorageSubjects.append, {
      message: {
        messageId,
        turnId: turn.turnId,
        sessionId,
        role: 'user',
        contentText: extractTextContent(content),
        blocks: normalizeToBlocks(content),
        timestamp: Date.now(),
      },
    });
  } catch (error: unknown) {
    console.warn('[attach-handler] Failed to store initial user message', {
      sessionId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await bus.requestOptional(TurnStorageSubjects.complete, {
        turnId: turn.turnId,
        status: 'error',
        expectedStatus: 'active',
        error: 'initial-message-persistence-failed',
      });
    } catch (completionError) {
      console.error('[attach-handler] Failed to rollback initial-message turn after message persistence failure', {
        sessionId,
        turnId: turn.turnId,
        error: completionError,
      });
    }
    throw error;
  }

  turn.addMessage(messageId);
  activeTurns.set(sessionId, turn);

  try {
    await emitInitialMessageEvents(bus, sessionId, turn, agentId, messageId, content);
  } catch (error) {
    if (activeTurns.get(sessionId)?.turnId === turn.turnId) {
      activeTurns.delete(sessionId);
    }
    throw error;
  }

  return { messageId, turnId: turn.turnId };
}

/**
 * Emit the attach initial-message lifecycle and user-message events.
 * @param bus - Bus instance for event emission
 * @param sessionId - Target session ID
 * @param turn - Active turn
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 */
async function emitInitialMessageEvents(
  bus: IMakaioBus,
  sessionId: string,
  turn: Turn,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<void> {
  await emitSessionTurnStarted(bus, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentIds: [...turn.agentIds],
    ingestionMarker: 'live',
  });
  await bus.emit(SessionSubjects.user_message.sent, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    content,
    agentIds: [...turn.agentIds],
  });
  await bus.emit(SessionSubjects.user_message.acknowledged, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    agentId,
  });
}
