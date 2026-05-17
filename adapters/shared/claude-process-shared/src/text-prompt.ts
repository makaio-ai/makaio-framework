import {
  formatContextBlockAsText,
  formatContextBlocksAsText,
  formatMessageHistoryAsTranscript,
  serializeTurnContext,
  type MessageHandle,
  type NormalizedMessageInput,
} from '@makaio/ai-adapters-core';

/**
 * Extract raw user text from normalized message input blocks.
 *
 * Filters to text-typed blocks only (non-text blocks such as images and
 * documents are not supported by text-based CLI transports and are silently
 * skipped). Falls back to the legacy `message` string when no text blocks
 * are present.
 * @param message - Normalized user message.
 * @returns Plain text content extracted from the message blocks.
 */
export function extractMessageText(message: NormalizedMessageInput): string {
  const textParts = message.blocks.filter((block) => block.type === 'text').map((block) => block.content);
  return textParts.join('\n') || message.message || '';
}

/**
 * Build a text prompt string suitable for text-based Claude process transports
 * (tmux send-keys, CLI `-p` flag).
 *
 * Assembles all turn material into a single string in the canonical order:
 * `merged_context → turn context → message_history → user text`.
 * Each non-empty segment is separated by a double newline.
 * @param handle - Message handle containing message text and contextual material.
 * @param mergedContent - Optional content merged from superseded immediate-mode messages.
 * @returns Final prompt text string ready for the process transport.
 */
export function buildTextPrompt(handle: MessageHandle, mergedContent?: string[]): string {
  const segments: string[] = [];

  if (mergedContent && mergedContent.length > 0) {
    segments.push(formatContextBlockAsText('merged_context', mergedContent.join('\n')));
  }

  const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
  if (contextText) {
    segments.push(contextText);
  }

  if (handle.messageHistory && handle.messageHistory.length > 0) {
    segments.push(formatContextBlockAsText('message_history', formatMessageHistoryAsTranscript(handle.messageHistory)));
  }

  segments.push(extractMessageText(handle.message));
  return segments.filter(Boolean).join('\n\n');
}
