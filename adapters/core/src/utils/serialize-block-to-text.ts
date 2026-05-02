import type { MessageBlock } from '@makaio/contracts/shared';

/**
 * Exhaustiveness guard for MessageBlock variants.
 * @param value - Unexpected block variant.
 * @returns Never returns.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled MessageBlock variant: ${JSON.stringify(value)}`);
}

/**
 * Serialize a {@link MessageBlock} to plain text for contexts where native
 * block rendering is unavailable — for example, media blocks in text positions,
 * or history serialization for providers that only accept string content.
 *
 * - `text` and `reasoning` blocks return their content verbatim.
 * - `tool_call` blocks emit a bracketed label followed by JSON-serialized args.
 * - `tool_output` blocks emit a bracketed label with the call ID and output body.
 * - `image` and `document` blocks emit a static placeholder.
 * - `attachment` blocks emit the display name when present, otherwise the file name.
 * @param block - The message block to serialize.
 * @returns Plain-text representation of the block.
 */
export function serializeBlockToText(block: MessageBlock): string {
  switch (block.type) {
    case 'text':
      return block.content;
    case 'reasoning':
      return block.content;
    case 'tool_call':
      return `[Tool: ${block.name}]\n${JSON.stringify(block.args)}`;
    case 'tool_output':
      return `[Tool ${block.isError ? 'Error' : 'Result'} ${block.toolCallId}]\n${block.output}`;
    case 'image':
      return '[Image]';
    case 'document':
      return '[Document]';
    case 'attachment': {
      // Treat empty/whitespace displayName as missing to avoid blank labels.
      const label = block.displayName?.trim() ? block.displayName : block.fileName || 'Attachment';
      return `[Attachment: ${label}]`;
    }
    default:
      return assertNever(block);
  }
}
