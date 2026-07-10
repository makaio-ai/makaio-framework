import { markCompletedWithFinalResult, type MessageResult } from '@makaio/ai-adapters-core';
import {
  parseResultError,
  resolveResultMessage,
  type ResultMessageWithStructuredOutput,
} from '@makaio/ai-adapters-claude-shared';
import type { OnTurnCompleteCallback } from './types/index.js';
import { ClaudeConnectorTurn } from './turn.js';

/**
 * Complete a Claude turn from its terminal SDK result.
 * @param msg - Terminal SDK result.
 * @param turn - Turn associated with the result.
 * @param onTurnComplete - Optional post-completion hook.
 */
export async function handleClaudeResultMessage(
  msg: ResultMessageWithStructuredOutput,
  turn: ClaudeConnectorTurn,
  onTurnComplete?: OnTurnCompleteCallback,
): Promise<void> {
  if (turn.isExpectingInterruptResult()) return;

  const isSuccess = msg.subtype === 'success' && !msg.is_error;
  const isWeirdSuccessWithError = msg.subtype === 'success' && msg.is_error;
  const result: MessageResult = isSuccess
    ? { outcome: 'completed', result: { message: resolveResultMessage(msg) } }
    : {
        outcome: 'error',
        error: normalizeResultError(msg),
        result: isWeirdSuccessWithError ? { message: resolveResultMessage(msg) } : undefined,
      };

  const handle = turn.getMessageHandle();
  if (handle) {
    await markCompletedWithFinalResult(handle, result, onTurnComplete);
  } else {
    turn.markCompleted(result);
  }
}

/**
 * Normalize SDK error payloads to an Error instance.
 * @param msg - Terminal SDK result.
 * @returns Normalized error.
 */
function normalizeResultError(msg: ResultMessageWithStructuredOutput): Error {
  const parsedError = parseResultError(msg);
  return parsedError instanceof Error ? parsedError : new Error(String(parsedError));
}
