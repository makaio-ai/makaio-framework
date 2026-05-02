import type { SDKUserMessage } from '@makaio/client-claude-code';
import { formatContextBlockAsText } from '@makaio/ai-adapters-core';

/**
 * Text content block for SDK messages.
 */
interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Prepends a context block to an SDK user message.
 * Used for injecting message history, merged context, or other prefixed content.
 * @param baseMessage - The original SDK user message
 * @param tag - XML-style tag name to wrap the content (e.g., 'message_history', 'merged_context')
 * @param content - The content to include within the tag
 * @returns New SDK user message with context block prepended and isSynthetic set to true
 */
export function prependContextBlock(baseMessage: SDKUserMessage, tag: string, content: string): SDKUserMessage {
  const contextBlock: TextBlock = {
    type: 'text',
    text: formatContextBlockAsText(tag, content),
  };

  const existingContent = baseMessage.message.content;
  const contentArray: TextBlock[] = Array.isArray(existingContent)
    ? (existingContent as TextBlock[])
    : [{ type: 'text', text: existingContent as string }];

  return {
    ...baseMessage,
    isSynthetic: true,
    message: {
      ...baseMessage.message,
      content: [contextBlock, ...contentArray],
    },
  };
}
