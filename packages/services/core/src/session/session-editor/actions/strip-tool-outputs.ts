import type { SessionMessage } from '@makaio/contracts';
import type { SessionEditorAction } from '../../../session-editor/types.js';

/**
 * Replaces tool output block contents with size placeholders.
 * @param messages - Messages to strip tool outputs from
 * @returns Messages with tool output contents replaced
 */
export function stripToolOutputBlocks(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((msg) => ({
    ...msg,
    blocks: msg.blocks.map((block) => {
      if (block.type === 'tool_output') {
        const charCount = block.output.length;
        return { ...block, output: `[output removed - ${charCount} chars]` };
      }
      return block;
    }),
  }));
}

/**
 * Strips tool_output block contents, keeping structure.
 * Replaces output with "[output removed - N chars]".
 * Tool outputs are often the largest blocks and least essential for context.
 *
 * `tool_output.output` is always a string by the `SessionMessageBlockSchema`
 * contract in `@makaio/contracts`, so replacing it with a size placeholder
 * preserves the block shape for downstream consumers.
 */
export const stripToolOutputsAction: SessionEditorAction = {
  id: 'strip-tool-outputs',
  label: 'Strip Tool Outputs',
  description: 'Remove tool output contents, keep structure',
  category: 'transformation',

  async execute(messages: SessionMessage[]) {
    return { kind: 'messages' as const, messages: stripToolOutputBlocks(messages) };
  },
};
