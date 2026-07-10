import type { SDKUserMessage } from '@makaio/client-claude-code';
import { serializeTurnContext, formatMessageHistoryAsTranscript, type MessageHandle } from '@makaio/ai-adapters-core';
import { prependContextBlock, sdkUserMessageFromNormalized } from '@makaio/ai-adapters-claude-shared';

/**
 * Build an SDK user message with turn context, message history, and any merged content prepended.
 *
 * Pure composition over the shared message helpers — kept outside the session
 * class so message construction stays independent of query lifecycle state.
 * @param handle - Message handle to process
 * @param sessionId - Provider session ID the message belongs to
 * @param agentId - Agent ID attached to the SDK message
 * @param mergedContent - Optional content from superseded messages (immediate mode)
 * @returns SDK user message ready to push to source
 */
export function buildSdkUserMessage(
  handle: MessageHandle,
  sessionId: string,
  agentId: string,
  mergedContent?: string[],
): SDKUserMessage {
  let sdkMessage = sdkUserMessageFromNormalized(handle.messageId, sessionId, agentId, handle.message);
  const contextBlocks = serializeTurnContext(handle.turnContext);
  for (let i = contextBlocks.length - 1; i >= 0; i--) {
    const block = contextBlocks[i];
    sdkMessage = prependContextBlock(sdkMessage, block.tag, block.content);
  }

  // Prepend message history if present
  if (handle.messageHistory && handle.messageHistory.length > 0) {
    const historyTranscript = formatMessageHistoryAsTranscript(handle.messageHistory);
    sdkMessage = prependContextBlock(sdkMessage, 'message_history', historyTranscript);
  }

  // Prepend merged content if present (for immediate mode)
  if (mergedContent && mergedContent.length > 0) {
    sdkMessage = prependContextBlock(sdkMessage, 'merged_context', mergedContent.join('\n'));
  }

  return sdkMessage;
}
