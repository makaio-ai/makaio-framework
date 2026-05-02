import type { SDKMessage } from '../namespace/index.js';

/**
 * Extract text content from an SDK assistant message.
 *
 * Assistant messages can contain text in various formats:
 * - Direct string content
 * - Array of content blocks where text blocks have type 'text'
 * @param message - SDK message to extract text from
 * @returns Extracted text content, or empty string if no text found
 * @example
 * ```typescript
 * const message = {
 *   type: 'assistant',
 *   message: { content: 'Hello world' }
 * };
 * extractTextFromMessage(message); // 'Hello world'
 * ```
 */
export function extractTextFromMessage(message: SDKMessage): string {
  if (message.type !== 'assistant') {
    return '';
  }

  const content = (message.message as { content?: unknown }).content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          block !== null && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block,
      )
      .map((block) => block.text)
      .join('');
  }

  return '';
}
