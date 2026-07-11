import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { Turn } from '../entities/turn.js';
import type { TurnCompleteCallback } from '../turn-completion.js';
import type { MessageOutcome } from '@makaio/contracts';

/** Narrow ledger transition owned by SessionTurnManager and injected into routing. */
export interface TurnCompletionRecorder {
  recordAgentCompletion(
    agentId: string,
    messageId: string,
    outcome: MessageOutcome,
    error: string | undefined,
    onTurnComplete: TurnCompleteCallback,
    turnId: string,
  ): Promise<void>;
}

/** Identity shared by the user-message routing lifecycle events. */
interface RoutingMessageIdentity {
  sessionId: string;
  turnId: string;
  turnNumber: number;
  messageId: string;
  agentId: string;
}

/**
 * Emit acknowledgement without misclassifying observer failure as send failure.
 *
 * Once `agent.sendMessage` succeeded, the agent may produce assistant output.
 * An acknowledgement observer cannot roll that delivery back, so its failure
 * is reported but must not terminalize the agent or settle persistence early.
 * @param bus - Bus instance for lifecycle delivery.
 * @param identity - Correlated message and agent identity.
 */
export async function emitRoutingAcknowledged(bus: IMakaioBus, identity: RoutingMessageIdentity): Promise<void> {
  try {
    await bus.emit(SessionSubjects.user_message.acknowledged, identity);
  } catch (error) {
    console.error('[SessionRouting] Failed to emit user-message acknowledgement:', error);
  }
}

/**
 * Settle assistant persistence when routing itself terminalizes an agent.
 * @param bus - Bus instance for local coordination.
 * @param turn - Turn containing the terminalized agent.
 * @param messageId - Exact user-message identity whose persistence cannot occur.
 * @param agentId - Agent whose assistant persistence cannot occur.
 */
export async function emitRoutingPersistenceSettlement(
  bus: IMakaioBus,
  turn: Pick<Turn, 'sessionId' | 'turnId'>,
  messageId: string,
  agentId: string,
): Promise<void> {
  await bus.emit(SessionSubjects.turn.assistantPersistenceSettled, {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    messageId,
    agentId,
  });
}

/** Terminal outcome produced directly by message routing. */
type RoutingTerminalOutcome = 'cancelled' | 'error';

/** Input required to terminalize one agent when routing cannot hand off delivery. */
interface TerminalizeRoutingAgentInput {
  /** Bus used for best-effort lifecycle observations. */
  readonly bus: IMakaioBus;
  /** Turn whose agent could not be routed. */
  readonly turn: Turn;
  /** Correlated user-message identity. */
  readonly messageId: string;
  /** Agent receiving the terminal outcome. */
  readonly agentId: string;
  /** Terminal routing outcome. */
  readonly outcome: RoutingTerminalOutcome;
  /** Provider or routing error for error outcomes. */
  readonly error?: string;
  /** Completion callback invoked exactly by the terminal Turn state transition. */
  readonly onTurnComplete: TurnCompleteCallback;
  /** Shared ledger owner for direct and provider terminal outcomes. */
  readonly turnManager: TurnCompletionRecorder;
}

/**
 * Terminalize a routing failure without letting lifecycle observers block turn completion.
 *
 * The in-memory Turn transition is authoritative: it must happen before either
 * observer is notified, and the resulting completion callback must run even
 * when persistence or user-message observers reject.  The observers still run
 * so their independent persistence work has its normal chance to complete.
 * @param input - Turn mutation, observer, and completion dependencies.
 */
export async function terminalizeRoutingAgent(input: TerminalizeRoutingAgentInput): Promise<void> {
  const { bus, turn, messageId, agentId, outcome, error, onTurnComplete, turnManager } = input;
  // Routing cannot produce an assistant message. Settle this exact pair
  // before the ledger's synchronous terminal transition can start its
  // persist-before-emit barrier.
  try {
    await emitRoutingPersistenceSettlement(bus, turn, messageId, agentId);
  } catch (settlementError) {
    console.error('[SessionRouting] Failed to emit terminal routing settlement:', settlementError);
  }
  await turnManager.recordAgentCompletion(agentId, messageId, outcome, error, onTurnComplete, turn.turnId);
}
