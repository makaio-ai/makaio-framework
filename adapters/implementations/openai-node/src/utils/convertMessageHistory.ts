import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/index.js';
// IMPORTANT: Use shared Message type (has .blocks), NOT agent/schemas/message.ts (has .content)
import type { Message } from '@makaio/contracts/shared';
import { serializeBlockToText } from '@makaio/ai-adapters-core';
import { blocksToContentParts } from './blockToContentPart.js';

/**
 * Convert curated message history to OpenAI ChatCompletionMessageParam[].
 *
 * Transforms the shared Message format (with blocks) into OpenAI's expected format:
 * - Text/reasoning blocks become assistant message content
 * - tool_call blocks become `tool_calls` on assistant messages
 * - tool_output blocks become separate `role: 'tool'` messages
 * - Media blocks (image, document, attachment) are skipped for assistant messages
 * - User message blocks are converted to native content parts (image_url, file, text)
 * - System message blocks are serialized to text (OpenAI system messages only accept strings)
 * @param history - Curated messages from sessionContext.messageHistory
 * @returns Array of OpenAI ChatCompletionMessageParam
 */
export function convertMessageHistory(history: Message[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (const msg of history) {
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [msg.blocks];

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: ChatCompletionMessageToolCall[] = [];
      const toolOutputs: Array<{ toolCallId: string; content: string; isError?: boolean }> = [];

      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            textParts.push(serializeBlockToText(block));
            break;
          case 'reasoning':
            // OpenAI doesn't have a native reasoning format — serialize to text
            textParts.push(serializeBlockToText(block));
            break;
          case 'tool_call':
            toolCalls.push({
              id: block.toolCallId,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.args) },
            });
            break;
          case 'tool_output':
            toolOutputs.push({ toolCallId: block.toolCallId, content: block.output, isError: block.isError });
            break;
          // image, document, attachment — skip (not relevant for text-based history)
        }
      }

      const validToolCallIds = new Set(toolCalls.map((call) => call.id));
      const matchedToolOutputs = toolOutputs.filter((output) => validToolCallIds.has(output.toolCallId));
      const orphanToolOutputs = toolOutputs.filter((output) => !validToolCallIds.has(output.toolCallId));
      for (const orphanOutput of orphanToolOutputs) {
        // OpenAI role=tool messages must reference an assistant tool_call in the same turn.
        // Keep orphan outputs as assistant text context instead of emitting invalid tool messages.
        textParts.push(
          serializeBlockToText({
            type: 'tool_output',
            toolCallId: orphanOutput.toolCallId,
            output: orphanOutput.content,
            isError: orphanOutput.isError,
          }),
        );
      }

      // Emit assistant message (with optional tool_calls)
      const assistantContent = textParts.join('\n');
      if (assistantContent.length > 0 || toolCalls.length > 0) {
        const assistantMsg: ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: assistantContent.length > 0 ? assistantContent : null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      }

      // Emit tool result messages (must follow the assistant message)
      for (const output of matchedToolOutputs) {
        result.push({
          role: 'tool',
          tool_call_id: output.toolCallId,
          content: output.isError ? `[Tool Error]\n${output.content}` : output.content,
        });
      }
    } else if (msg.role === 'system') {
      // System messages only accept string content — serialize blocks to text.
      const content = blocks.map(serializeBlockToText).join('\n');
      if (content.length > 0) {
        result.push({ role: 'system', content });
      }
    } else {
      // User messages — convert blocks to structured content parts so media
      // blocks (images, PDFs, attachments) are passed natively to the API.
      const parts = blocksToContentParts(blocks);
      if (parts.length > 0) {
        // If every part is text, collapse to a plain string for cleaner serialization.
        const allText = parts.every((p) => p.type === 'text');
        const content = allText ? parts.map((p) => (p as { type: 'text'; text: string }).text).join('\n') : parts;
        result.push({ role: 'user', content });
      }
    }
  }

  return result;
}
