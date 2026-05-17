import { buildTextPrompt } from '@makaio/ai-adapters-claude-process-shared';
import type { MessageHandle } from '@makaio/ai-adapters-core';

/**
 * Build the prompt text string to send via tmux send-keys.
 *
 * Final prompt order is merged context, then turn context, then message history,
 * then user text.
 * @param handle - Message handle containing message text and contextual material.
 * @param mergedContent - Optional content merged from superseded messages.
 * @returns Final prompt text string for send-keys.
 */
export function buildMessageText(handle: MessageHandle, mergedContent?: string[]): string {
  return buildTextPrompt(handle, mergedContent);
}
