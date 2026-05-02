/**
 * User input assembly utilities for Codex App-Server turn/start.
 *
 * Builds the `input` array expected by `turn/start` from a normalized
 * `MessageHandle`, inserting history, merged context, turn context, and
 * content blocks in the correct order.
 */

import { serializeTurnContext, formatContextBlocksAsText } from '@makaio/ai-adapters-core';
import type { MessageHandle, NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { UserInput } from '../protocol/generated/v2/index.js';
import { convertBlockToUserInput } from './attachmentHelpers.js';
import { formatMessageHistory } from './formatMessageHistory.js';

/**
 * Assemble the `input` array for a `turn/start` request from a message handle.
 *
 * Ordering: outermost → innermost is
 * `message_history` → `merged_context` → `turn_context` → user text and blocks.
 * @param messageHandle - The message handle carrying user input and context
 * @param mergedContent - Optional array of prior message text merged into this turn
 * @returns Ordered array of `UserInput` items for `turn/start`
 */
export function buildUserInputs(messageHandle: MessageHandle, mergedContent?: string[]): UserInput[] {
  const messageContent: NormalizedMessageInput = messageHandle.message;
  const userInputs: UserInput[] = [];

  const historyPrefix = formatMessageHistory(messageHandle.messageHistory);
  if (historyPrefix) {
    userInputs.push({
      type: 'text' as const,
      text: `[CONVERSATION HISTORY]\n${historyPrefix}[END CONVERSATION HISTORY]\n\n`,
    });
  }

  if (mergedContent && mergedContent.length > 0) {
    const mergedText = `[MERGED CONTEXT FROM PREVIOUS MESSAGES]\n${mergedContent.join('\n')}\n[END MERGED CONTEXT]\n\n`;
    userInputs.push({ type: 'text' as const, text: mergedText });
  }

  const contextText = formatContextBlocksAsText(serializeTurnContext(messageHandle.turnContext));
  if (contextText) {
    userInputs.push({ type: 'text' as const, text: contextText });
  }

  for (const block of messageContent.blocks) {
    const input = convertBlockToUserInput(block);
    if (input) userInputs.push(input);
  }

  // messageContent.message is derived from the first text block by normalizeMessageInput(),
  // not independent content. This fallback only fires when no prior push (history, merged
  // context, context blocks, or message blocks) produced any inputs — preventing duplication
  // when block-derived or context-derived inputs already contain the same text.
  if (userInputs.length === 0 && messageContent.message) {
    userInputs.push({ type: 'text' as const, text: messageContent.message });
  }

  return userInputs;
}
