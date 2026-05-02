import {
  serializeTurnContext,
  formatContextBlockAsText,
  formatContextBlocksAsText,
  formatMessageHistoryAsTranscript,
  type NormalizedMessageInput,
} from '@makaio/ai-adapters-core';
import type { JsonValue, Message } from '@makaio/contracts';
import type { ContentBlock } from '@agentclientprotocol/sdk';

/**
 * Builds ACP `ContentBlock` array from a normalized user message.
 *
 * The system prompt is injected via the `QWEN_SYSTEM_MD` environment variable
 * (a path to a temp file written by the connector), not as a content block.
 *
 * Block ordering: conversation history → merged context → turn context → user message.
 * @param message - The normalized user message
 * @param messageHistory - Optional prior conversation messages for context
 * @param turnContext - Optional per-turn context key/value record
 * @param mergedContent - Optional text from superseded/merged messages (immediate mode)
 * @returns Array of ACP `ContentBlock` for the `session/prompt` request
 */
export function buildPromptContent(
  message: NormalizedMessageInput,
  messageHistory?: Message[],
  turnContext?: Record<string, JsonValue>,
  mergedContent?: string[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Inject conversation history as a human-readable transcript.
  if (messageHistory && messageHistory.length > 0) {
    const transcript = formatMessageHistoryAsTranscript(messageHistory);
    blocks.push({ type: 'text', text: `[CONVERSATION HISTORY]\n${transcript}\n[END CONVERSATION HISTORY]\n\n` });
  }

  // Inject merged content from superseded/enqueued messages (immediate mode).
  if (mergedContent?.length) {
    blocks.push({ type: 'text', text: `${formatContextBlockAsText('merged_context', mergedContent.join('\n'))}\n\n` });
  }

  // Inject per-turn context as XML-tagged blocks.
  if (turnContext) {
    const contextText = formatContextBlocksAsText(serializeTurnContext(turnContext));
    if (contextText) {
      blocks.push({ type: 'text', text: `${contextText}\n\n` });
    }
  }

  // Add user message text content.
  const userText = message.message ?? '';
  if (userText) {
    blocks.push({ type: 'text', text: userText });
  }

  // ACP requires at least one content block in the prompt array.
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}
