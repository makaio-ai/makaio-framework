/**
 * Format message history as a prompt prefix for codex app-server.
 *
 * Since the codex app-server protocol's turn/start only accepts user input,
 * we serialize the message history into a human-readable format that
 * the AI can understand as conversation context.
 */
import { formatMessageHistoryAsTranscript } from '@makaio/ai-adapters-core';
import type { Message } from '@makaio/contracts/shared';

/**
 * Format curated message history as a text prefix.
 *
 * Serializes the history into a format the AI can understand as prior context.
 * Uses role labels to distinguish different message types.
 * @param history - Curated messages from sessionContext.messageHistory
 * @returns Formatted string to prepend to the prompt, or empty string if no history
 */
export function formatMessageHistory(history: Message[] | undefined): string {
  if (!history || history.length === 0) return '';
  return `${formatMessageHistoryAsTranscript(history)}\n\n`;
}
