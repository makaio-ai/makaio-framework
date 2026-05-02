import type { SessionMessage } from '@makaio/contracts';
import type { SessionEditorAction } from '../../../session-editor/types.js';

/**
 * Removes reasoning blocks from messages.
 * @param messages - Messages to strip reasoning from
 * @returns Messages with reasoning blocks removed
 */
export function stripReasoningBlocks(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((msg) => ({
    ...msg,
    blocks: msg.blocks.filter((block) => block.type !== 'reasoning'),
  }));
}

/**
 * Removes reasoning blocks from messages.
 * Reasoning content is typically high-token internal detail that is not required
 * for follow-up context reconstruction.
 */
export const stripReasoningAction: SessionEditorAction = {
  id: 'strip-reasoning',
  label: 'Strip Reasoning',
  description: 'Remove reasoning/thinking blocks from messages',
  category: 'transformation',

  async execute(messages: SessionMessage[]) {
    return { kind: 'messages' as const, messages: stripReasoningBlocks(messages) };
  },
};
