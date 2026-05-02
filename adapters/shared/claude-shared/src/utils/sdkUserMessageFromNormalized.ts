import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { SDKUserMessage } from '@makaio/client-claude-code';
import { blocksToContentBlocks } from './blocksToContentBlocks.js';

type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Converts a normalized message input to SDK user message format.
 *
 * When `message.message` is present it is used directly as a string content
 * value (fast path). Otherwise `message.blocks` are converted to Anthropic
 * content block params via {@link blocksToContentBlocks}.
 * @param messageId - Unique identifier for the message
 * @param sessionId - Session identifier
 * @param agentId - Agent identifier that owns this message
 * @param message - Normalized message input to convert
 * @returns SDK user message object
 */
export function sdkUserMessageFromNormalized(
  messageId: string,
  sessionId: string,
  agentId: string,
  message: NormalizedMessageInput,
): SDKUserMessage {
  const content = typeof message.message === 'string' ? message.message : blocksToContentBlocks(message.blocks);

  return {
    uuid: messageId as UUID,
    session_id: sessionId,
    agentId,
    type: 'user',
    parent_tool_use_id: null,
    isSynthetic: false,
    message: {
      role: 'user',
      content,
    },
  };
}
