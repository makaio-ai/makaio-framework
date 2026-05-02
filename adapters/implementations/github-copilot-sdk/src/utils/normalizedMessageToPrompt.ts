import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';

/**
 * Convert normalized message to prompt string.
 * @param message - Normalized message input
 * @returns Prompt string
 */
export function normalizedMessageToPrompt(message: NormalizedMessageInput): string {
  if ('message' in message && typeof message['message'] === 'string') {
    return message['message'];
  }
  // Handle MessageParam format
  if ('content' in message) {
    if (typeof message.content === 'string') return message.content;

    // Extract text from content array
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block) => 'type' in block && block.type === 'text')
        .map((block) => ('text' in block ? block.text : ''))
        .join('\n');
    }
  }

  return String(message);
}
