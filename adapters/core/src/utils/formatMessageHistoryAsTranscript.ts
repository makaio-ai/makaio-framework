import type { Message, MessageBlock } from '@makaio/contracts';

/**
 * Extracts text content from a MessageBlock.
 * Handles all block types: text content is returned directly,
 * tool/reasoning blocks produce structured text, media blocks return placeholders.
 * @param block - The message block to extract text from
 * @returns Text content or placeholder description
 */
function extractBlockText(block: MessageBlock): string {
  // Deliberately "human transcript" formatting.
  // For provider/API-safe compact serialization use serializeBlockToText().
  switch (block.type) {
    case 'text':
      return block.content;
    case 'image':
      return '[Image]';
    case 'document':
      return '[Document]';
    case 'attachment':
      return `[Attachment: ${block.displayName ?? block.fileName}]`;
    case 'reasoning':
      return `[Reasoning]\n${block.content}`;
    case 'tool_call':
      return `[Tool: ${block.name}]\n${JSON.stringify(block.args, null, 2)}`;
    case 'tool_output':
      return `[Tool ${block.isError ? 'Error' : 'Result'}]\n${block.output}`;
  }
}

/**
 * Formats message history as a human-readable conversation transcript.
 *
 * Converts structured Message[] into plain text format:
 * ```
 * User: Hello, my name is Alice
 * Assistant: Nice to meet you, Alice!
 * ```
 *
 * This avoids exposing JSON structure to the LLM, which can trigger
 * meta-analysis of the format rather than natural conversation continuation.
 * @param history - Array of Message objects with role and blocks
 * @returns Human-readable transcript string
 */
export function formatMessageHistoryAsTranscript(history: Message[]): string {
  return history
    .map((msg) => {
      const role = msg.role ?? 'user';
      const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

      const blocks = Array.isArray(msg.blocks) ? msg.blocks : [msg.blocks];
      const content = blocks.map(extractBlockText).join('\n');

      return `${roleLabel}: ${content}`;
    })
    .join('\n');
}
