/**
 * Initial-message turn tracking for session.agent.attach.
 *
 * The attach flow starts an adapter agent before it can persist the initial
 * user message. These helpers keep the rollback contract local to that seam.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import type { IMakaioSession, MessageInput, SessionContext, StartAgentResponse } from '@makaio/contracts';
import { Turn } from '../entities/turn.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { emitSessionTurnStarted, emitSessionUserMessageSent } from '../session-lifecycle-events.js';
import { extractTextContent, normalizeToBlocks } from '../session-orchestrator-helpers.js';
import type { SessionTurnManager } from '../session-turn-manager.js';
import type { TurnReservation } from '../session-turn-manager.js';
import { routeToAgentsCore } from './route-to-agents-core.js';

/** Prepared initial attach turn and its canonical user-message identity. */
interface PreparedInitialAttachTurn {
  readonly messageId: string;
  readonly turn: Turn;
}

/**
 * Set up initial-message turn tracking and stop the started agent if setup fails.
 * @param bus - Bus instance for storage and adapter rollback
 * @param turnManager - Shared owner of attach turn lifecycle state
 * @param reservation - Exclusive session turn slot reserved before agent startup
 * @param startResult - Successful adapter startup result
 * @param sessionId - Target session ID
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 * @returns Turn tracking info
 */
async function setupInitialAttachTurnOrRollbackAgent(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  reservation: TurnReservation,
  startResult: Extract<StartAgentResponse, { success: true }>,
  sessionId: string,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<PreparedInitialAttachTurn> {
  try {
    return await setupInitialAttachTurn(bus, turnManager, reservation, sessionId, agentId, messageId, content);
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
 * Create and persist the initial attach turn before delivering it to the idle agent.
 *
 * The message identity is created before provider dispatch and is forwarded
 * unchanged through the ordinary agent routing pipeline.
 * @param bus - Bus for turn persistence and agent routing
 * @param turnManager - Shared owner of the session turn lifecycle
 * @param reservation - Exclusive session turn slot reserved before agent startup
 * @param startResult - Registered idle agent identity
 * @param session - Session receiving the initial turn
 * @param initialMessage - User message to deliver after persistence
 * @param sessionContext - Attach locality and history context for delivery
 * @returns Canonical identifiers for the newly created turn and message
 */
export async function dispatchInitialAttachMessage(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  reservation: TurnReservation,
  startResult: Extract<StartAgentResponse, { success: true }>,
  session: IMakaioSession,
  initialMessage: MessageInput,
  sessionContext: SessionContext | undefined,
): Promise<{ messageId: string; turnId: string }> {
  const prepared = await setupInitialAttachTurnOrRollbackAgent(
    bus,
    turnManager,
    reservation,
    startResult,
    session.sessionId,
    startResult.agentId,
    crypto.randomUUID(),
    initialMessage,
  );
  let outcomes;
  try {
    outcomes = await routeToAgentsCore(
      bus,
      session,
      [{ agentId: startResult.agentId, adapterId: startResult.adapterId }],
      initialMessage,
      prepared.messageId,
      prepared.turn,
      undefined,
      turnManager.completeTurn.bind(turnManager),
      turnManager,
      sessionContext,
      undefined,
    );
  } catch (error) {
    try {
      await turnManager.retryTurnCompletion(prepared.turn.turnId);
    } catch (retryError) {
      console.error('[attach-handler] Failed to retry initial-message completion after routing failure', {
        sessionId: session.sessionId,
        turnId: prepared.turn.turnId,
        error: retryError,
      });
    }
    await stopStartedAgentAfterFailure(bus, startResult, session.sessionId, 'initial-message routing failure');
    throw error;
  }
  const outcome = outcomes[0];
  if (!outcome || outcome.kind === 'dispatched') {
    return { messageId: prepared.messageId, turnId: prepared.turn.turnId };
  }

  await stopStartedAgentAfterFailure(bus, startResult, session.sessionId, 'initial-message routing failure');
  throw outcome.error;
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
 * Sets up an initial attach turn and emits turn/message events before dispatch.
 *
 * Persists the turn via storage to obtain a monotonic `turnNumber` before
 * emitting lifecycle events (which include `turnNumber` in their schema).
 * @param bus - Bus instance for event emission and storage
 * @param turnManager - Shared owner of attach turn lifecycle state
 * @param reservation - Exclusive session turn slot reserved before agent startup
 * @param sessionId - Target session ID
 * @param agentId - Agent processing the message
 * @param messageId - User message ID
 * @param content - Message content
 * @returns Turn tracking info
 */
async function setupInitialAttachTurn(
  bus: IMakaioBus,
  turnManager: SessionTurnManager,
  reservation: TurnReservation,
  sessionId: string,
  agentId: string,
  messageId: string,
  content: MessageInput,
): Promise<PreparedInitialAttachTurn> {
  const turn = await turnManager.createReservedTurn(reservation, [agentId]);
  const admission = turnManager.admitReservedMessage(turn, messageId, [agentId]);

  try {
    const append = await bus.requestOptional(MessageStorageSubjects.append, {
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
    if (!append.handled) throw new Error('Message storage append handler is not registered');
  } catch (error: unknown) {
    console.warn('[attach-handler] Failed to store initial user message', {
      sessionId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      await admission.rollback('initial-message-persistence-failed');
    } catch (cleanupError) {
      console.error('[attach-handler] Failed to finalize rejected initial-message persistence:', cleanupError);
    }
    throw error;
  }

  try {
    await emitInitialMessageEvents(bus, sessionId, turn, messageId, content);
  } catch (error) {
    try {
      await admission.rollback('initial-message-lifecycle-failed');
    } catch (cleanupError) {
      console.error('[attach-handler] Failed to finalize rejected initial-message lifecycle:', cleanupError);
    }
    throw error;
  }

  admission.commit();

  return { messageId, turn };
}

/**
 * Emit the attach initial-message lifecycle and user-message events.
 * @param bus - Bus instance for event emission
 * @param sessionId - Target session ID
 * @param turn - Active turn
 * @param messageId - User message ID
 * @param content - Message content
 */
async function emitInitialMessageEvents(
  bus: IMakaioBus,
  sessionId: string,
  turn: Turn,
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
  await emitSessionUserMessageSent(bus, {
    sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId,
    content,
    agentIds: [...turn.agentIds],
  });
}
