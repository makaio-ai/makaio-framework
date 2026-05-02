import type { Message, MessageBlock, MessageInput } from '@makaio/contracts';

export type NormalizedMessageInput = Required<Message> & {
  blocks: MessageBlock[];
  message?: string;
};
/**
 * Normalizes various MessageInput formats into a consistent structure with blocks and optional message text.
 * @param input - The message input to normalize (string or Message object)
 * @returns Normalized message with role, blocks array, and optional message text
 */
export function normalizeMessageInput(input: MessageInput): NormalizedMessageInput {
  if (typeof input === 'string') {
    return {
      role: 'user',
      blocks: [{ type: 'text', content: input }],
      message: input,
    };
  }

  const blocks = Array.isArray(input.blocks) ? input.blocks : [input.blocks];
  const blockWithMessage = blocks.find((it) => it.type === 'text');

  return {
    role: input.role ?? 'user',
    blocks,
    message: blockWithMessage?.content,
  };
}
