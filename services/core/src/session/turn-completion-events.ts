import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type MessageOutcome } from '@makaio/contracts';
import type { Turn } from './entities/turn.js';
import type { TurnCompleteCallback, TurnCompletionResult } from './turn-completion.js';
import type { AgentUsageEvent } from './turn-usage-accumulator.js';

/** Dependencies kept in SessionTurnManager while event sequencing lives here. */
export interface TurnCompletionEventHooks {
  resolveUsageTurn(turnId: string): Turn | undefined;
  resolveCompletionTurn(turnId: string): Turn | undefined;
  isCompletionInFlight(turnId: string): boolean;
  addUsage(turn: Turn, event: AgentUsageEvent): void;
  bufferUsage(turnId: string, event: AgentUsageEvent): void;
  canRetry(turnId: string): boolean;
  retry(turnId: string): Promise<void>;
  beginFinalization(turn: Turn, result: TurnCompletionResult): void;
}

/**
 * Register agent usage/completion subscriptions against manager-owned hooks.
 * @param bus - Bus carrying normalized agent events.
 * @param hooks - Manager-owned state transition hooks.
 * @param onTurnComplete - Canonical terminal callback.
 * @returns Subscription cleanup callbacks.
 */
export function registerTurnCompletionEvents(
  bus: IMakaioBus,
  hooks: TurnCompletionEventHooks,
  onTurnComplete: TurnCompleteCallback,
): Array<() => void> {
  return [
    bus.on(AgentSubjects.usage, (ctx) => {
      const { agentId, turnId, inputTokens, inputCachedTokens, outputTokens, granularity, llmCallId } = ctx.payload;
      if (!turnId) {
        console.warn(`[SessionTurnManager] Dropping usage event without turnId (agentId=${agentId}).`);
        return;
      }
      const turn = hooks.resolveUsageTurn(turnId);
      if (!turn || !turn.hasAgent(agentId)) return;
      const event = {
        agentId,
        inputTokens,
        inputCachedTokens,
        outputTokens,
        granularity,
        ...(llmCallId && { llmCallId }),
      };
      if (hooks.isCompletionInFlight(turn.turnId)) hooks.bufferUsage(turn.turnId, event);
      else hooks.addUsage(turn, event);
    }),
    bus.on(AgentSubjects.complete, async (ctx) => {
      const { agentId, outcome, error, turnId, messageId } = ctx.payload;
      if ((ctx.payload as Record<string, unknown>)['_import'] || !turnId) return;
      await recordTurnPairCompletion(bus, hooks, {
        agentId,
        messageId,
        outcome: outcome ?? 'completed',
        error: outcome === 'error' ? error : undefined,
        turnId,
        onTurnComplete,
      });
    }),
  ];
}

/**
 * Record one exact delivery outcome and finalize the turn when its ledger closes.
 * @param bus - Bus used for lifecycle observation.
 * @param hooks - Manager-owned state transition hooks.
 * @param input - Exact pair outcome and terminal callback.
 * @returns Promise resolved after observation and any finalization.
 */
export async function recordTurnPairCompletion(
  bus: IMakaioBus,
  hooks: TurnCompletionEventHooks,
  input: {
    agentId: string;
    messageId: string;
    outcome: MessageOutcome;
    error?: string;
    turnId: string;
    onTurnComplete: TurnCompleteCallback;
  },
): Promise<void> {
  const turn = hooks.resolveCompletionTurn(input.turnId);
  if (!turn?.hasAgent(input.agentId)) return;
  const change = turn.recordPairTerminal(input.messageId, input.agentId, input.outcome, input.error);
  if (!change.accepted) {
    if (hooks.canRetry(turn.turnId)) await hooks.retry(turn.turnId);
    return;
  }
  if (change.turnComplete) hooks.beginFinalization(turn, change.result);
  const observation = bus.emit(SessionSubjects.user_message.completed, {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnNumber: turn.turnNumber,
    messageId: input.messageId,
    agentId: input.agentId,
    outcome: input.outcome,
    ...(input.error !== undefined && { error: input.error }),
  });
  const finalization = change.turnComplete ? input.onTurnComplete(turn, change.result) : Promise.resolve();
  const [observed, finalized] = await Promise.allSettled([observation, finalization]);
  if (observed.status === 'rejected') {
    console.error('[SessionTurnManager] Failed to emit user-message completion:', observed.reason);
  }
  if (finalized.status === 'rejected') throw finalized.reason;
}
