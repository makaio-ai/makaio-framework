import type { SDKMessage, SDKUserMessage } from '@makaio/client-claude-code';
import type { CallContext } from '@makaio/core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ClaudeConnectorTurn } from './turn.js';
import type { OnTurnCompleteCallback } from './types/index.js';
import { handleClaudeResultMessage } from './result-handling.js';

/**
 * Apply an SDK message to the active turn after connector-level emission.
 * @param call - Active message call or the SDK observer origin.
 * @param sdkMessage - Routed SDK message.
 * @param turn - Active turn, if one exists.
 * @param onTurnComplete - Optional post-completion hook.
 */
export async function handleTurnSdkEvent(
  call: CallContext,
  sdkMessage: SDKMessage,
  turn: ClaudeConnectorTurn | undefined,
  onTurnComplete?: OnTurnCompleteCallback,
): Promise<void> {
  if (!turn) return;

  if (sdkMessage.type === 'user' && (sdkMessage as SDKUserMessage & { isReplay?: boolean }).isReplay) {
    turn.markAcknowledged();
  }
  if (sdkMessage.type === 'result') {
    await handleClaudeResultMessage(sdkMessage, turn, onTurnComplete);
  }
  await turn.handleSdkEvent(call, sdkMessage);
}

/**
 * Call an incoming SDK message is handled under: the active turn's message while it is
 * still open, otherwise an observer origin (output that no handled message caused).
 * @param bus - Adapter carrier that emits the SDK message
 * @param turn - The session's current turn, if any
 * @returns Call for the SDK message's sends
 */
export function callForSdkMessage(bus: Pick<IMakaioBus, 'own'>, turn: ClaudeConnectorTurn | undefined): CallContext {
  const handle = turn?.getMessageHandle();
  // ORIGIN: SDK output without an open message belongs to the emitting adapter carrier.
  return handle && !handle.isProcessed ? handle.call : bus.own('observer');
}
