import type { SessionMessage } from '@makaio/contracts';
import type { SessionEditorAction } from '../../../session-editor/types.js';

/**
 * Converts messages to context JSON.
 * This is the final step in a compression pipeline - takes (possibly transformed)
 * messages and outputs them as a context JSON blob for the squash event.
 *
 * Future alternative: an LLM-based summarizer that produces a smarter summary.
 */
export const messagesToContextAction: SessionEditorAction = {
  id: 'messages-to-context',
  label: 'Export as Context',
  description: 'Convert messages to context JSON (final step)',
  category: 'extraction',

  async execute(messages: SessionMessage[]) {
    // Extract text content for the context summary
    const contextMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.blocks
        .map((block) => {
          if (block.type === 'text') return block.content;
          if (block.type === 'reasoning') return `[reasoning: ${block.content}]`;
          if (block.type === 'tool_call') return `[tool: ${block.name}]`;
          if (block.type === 'tool_output') return block.output;
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    }));

    // Estimate tokens (~4 chars per token)
    const totalChars = contextMessages.reduce((sum, m) => sum + m.content.length, 0);
    const tokenEstimate = Math.ceil(totalChars / 4);

    return {
      kind: 'context' as const,
      json: {
        type: 'compressed-messages',
        messageCount: messages.length,
        messages: contextMessages,
      },
      tokenEstimate,
    };
  },
};
