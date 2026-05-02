import type { MessageBlock, MessageInput, SessionMessageBlock } from '@makaio/contracts';

/**
 * Extract plain text content from a MessageInput for FTS indexing.
 * @param message - The message input (string or structured)
 * @returns Plain text content
 */
export function extractTextContent(message: MessageInput): string {
  if (typeof message === 'string') {
    return message;
  }
  const blocks = Array.isArray(message.blocks) ? message.blocks : [message.blocks];
  return blocks
    .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
    .map((b) => b.content)
    .join('\n');
}

/**
 * Convert a shared MessageBlock to a SessionMessageBlock.
 * Since the types are unified, this is a direct pass-through.
 * @param block - The input message block
 * @returns SessionMessageBlock for storage
 */
export function convertToSessionBlock(block: MessageBlock): SessionMessageBlock {
  return block;
}

/**
 * Normalize MessageInput to SessionMessageBlock[] for storage.
 * Preserves structured blocks instead of flattening to a single text block.
 * @param message - The message input (string or structured)
 * @returns Array of SessionMessageBlock for storage
 */
export function normalizeToBlocks(message: MessageInput): SessionMessageBlock[] {
  if (typeof message === 'string') {
    return [{ type: 'text', content: message }];
  }
  const blocks = Array.isArray(message.blocks) ? message.blocks : [message.blocks];
  return blocks.map(convertToSessionBlock);
}
