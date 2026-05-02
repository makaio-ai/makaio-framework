import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { MessageBlock } from '@makaio/contracts/shared';

/**
 * Extract text content from a NormalizedMessageInput.
 *
 * Safely handles messages where:
 * - message.message is undefined (non-text content like images)
 * - content is in blocks array
 * @param message - The normalized message input
 * @returns Extracted text content, or empty string if no text found
 */
export function extractTextFromMessage(message: NormalizedMessageInput): string {
  // Prefer the convenience message field if available
  if (typeof message.message === 'string' && message.message.length > 0) {
    return message.message;
  }

  // Fall back to extracting from blocks
  if (!Array.isArray(message.blocks) || message.blocks.length === 0) {
    return '';
  }

  return message.blocks
    .filter((b): b is MessageBlock & { content: string } => b.type === 'text' && typeof b.content === 'string')
    .map((b) => b.content)
    .join('\n');
}
