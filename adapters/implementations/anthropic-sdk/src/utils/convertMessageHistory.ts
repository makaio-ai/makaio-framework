import type {
  Base64ImageSource,
  DocumentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { serializeBlockToText, isTextLikeMimeType, normalizeMimeType } from '@makaio/ai-adapters-core';
// IMPORTANT: Use shared Message type (has .blocks), NOT agent/schemas/message.ts (has .content)
import type { ContentSource, Message, MessageBlock } from '@makaio/contracts/shared';

/** Valid media types for Anthropic base64 image sources. */
const VALID_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMediaType = Base64ImageSource['media_type'];

/** Union of content block param types valid inside an assistant message. */
type AssistantContentBlock = TextBlockParam | ThinkingBlockParam | ToolUseBlockParam;

/** Union of content block param types valid inside a user message. */
type UserContentBlock = TextBlockParam | ImageBlockParam | DocumentBlockParam;

/**
 * Resolve a MIME type against an allowed set, returning a fallback when absent or unrecognised.
 * @param mimeType - MIME type string from the content source, if present.
 * @param validTypes - Read-only tuple of accepted MIME type literals.
 * @param fallback - Value to return when `mimeType` is absent or not in `validTypes`.
 * @returns The matched type or `fallback`.
 */
function resolveMediaType<T extends string>(mimeType: string | undefined, validTypes: readonly T[], fallback: T): T {
  if (mimeType !== undefined && (validTypes as readonly string[]).includes(mimeType)) {
    return mimeType as T;
  }
  return fallback;
}

/**
 * Resolve the `media_type` for an Anthropic base64 image source.
 *
 * Falls back to `'image/jpeg'` when the MIME type is absent or not in the
 * set of types the Anthropic API accepts.
 * @param mimeType - MIME type string from the content source, if present.
 * @returns A valid Anthropic image media type.
 */
function resolveImageMediaType(mimeType: string | undefined): ImageMediaType {
  return resolveMediaType(mimeType, VALID_IMAGE_MEDIA_TYPES, 'image/jpeg');
}

/**
 * Convert a {@link ContentSource} to a native Anthropic {@link ImageBlockParam}.
 * @param source - The content source for the image block.
 * @param normalizedMimeType - Pre-normalized MIME type to use instead of `source.mimeType`.
 *   When provided, the caller's value is preferred; `source.mimeType` is always normalized
 *   before comparison regardless.
 * @returns An Anthropic `ImageBlockParam`.
 */
function imageSourceToParam(source: ContentSource, normalizedMimeType?: string): ImageBlockParam {
  if (source.type === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        data: source.data,
        media_type: resolveImageMediaType(normalizedMimeType ?? normalizeMimeType(source.mimeType)),
      },
    };
  }
  return { type: 'image', source: { type: 'url', url: source.url } };
}

/**
 * Convert a {@link ContentSource} to a native Anthropic {@link DocumentBlockParam}.
 *
 * Selects the correct Anthropic source shape based on the normalized media type:
 * - `'text/plain'` maps to {@link PlainTextSource} (`type: 'text'`).
 * - All other accepted types (or absent/unknown MIME) map to {@link Base64PDFSource}
 *   (`type: 'base64'`, `media_type: 'application/pdf'`).
 * @param source - The content source for the document block.
 * @returns An Anthropic `DocumentBlockParam`.
 */
function documentSourceToParam(source: ContentSource): DocumentBlockParam {
  if (source.type === 'base64') {
    const normalizedMediaType = normalizeMimeType(source.mimeType);
    if (normalizedMediaType === 'text/plain') {
      return {
        type: 'document',
        source: { type: 'text', data: Buffer.from(source.data, 'base64').toString('utf8'), media_type: 'text/plain' },
      };
    }
    return {
      type: 'document',
      source: { type: 'base64', data: source.data, media_type: 'application/pdf' },
    };
  }
  return { type: 'document', source: { type: 'url', url: source.url } };
}

/**
 * Convert a single user {@link MessageBlock} to an Anthropic {@link UserContentBlock}.
 *
 * - `text` blocks become `TextBlockParam`.
 * - `image` blocks become native `ImageBlockParam`.
 * - `document` blocks become native `DocumentBlockParam`.
 * - `attachment` blocks are mapped by the normalized `source.mimeType`: Anthropic-supported image types
 *   (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) produce `ImageBlockParam`; unsupported image
 *   variants (e.g. `image/svg+xml`) fall through to the text path; `application/pdf` produces a base64
 *   `DocumentBlockParam`; text-like MIME types (including those with parameters like "text/plain; charset=utf-8")
 *   produce a decoded plain-text `DocumentBlockParam`; all other MIME types or non-base64 sources fall back to
 *   `TextBlockParam`.
 * - All other block types fall back to a `TextBlockParam` via `serializeBlockToText`.
 * @param block - The message block to convert.
 * @returns An Anthropic user content block.
 */
function userBlockToContentBlock(block: MessageBlock): UserContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.content };
    case 'image': {
      const normalizedMime = block.source.type === 'base64' ? normalizeMimeType(block.source.mimeType) : undefined;
      return imageSourceToParam(block.source, normalizedMime);
    }
    case 'document':
      return documentSourceToParam(block.source);
    case 'attachment': {
      if (block.source.type !== 'base64') {
        return { type: 'text', text: serializeBlockToText(block) };
      }
      const normalizedMimeType = normalizeMimeType(block.source.mimeType);
      if ((VALID_IMAGE_MEDIA_TYPES as readonly string[]).includes(normalizedMimeType)) {
        return imageSourceToParam(block.source, normalizedMimeType);
      }
      if (normalizedMimeType === 'application/pdf') {
        return documentSourceToParam(block.source);
      }
      if (isTextLikeMimeType(normalizedMimeType)) {
        const decoded = Buffer.from(block.source.data, 'base64').toString('utf-8');
        return {
          type: 'document',
          source: { type: 'text', data: decoded, media_type: 'text/plain' },
        } satisfies DocumentBlockParam;
      }
      return { type: 'text', text: serializeBlockToText(block) };
    }
    default:
      return { type: 'text', text: serializeBlockToText(block) };
  }
}

/** Intermediate shape for a collected tool output before Anthropic serialization. */
interface CollectedToolOutput {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * Convert a reasoning block to an {@link AssistantContentBlock}.
 *
 * Emits a native `ThinkingBlockParam` when `metadata.signature` is present
 * (captured from Anthropic `signature_delta` events during streaming). Falls
 * back to a `text` block when only content is available, and returns `null`
 * when both are absent so the caller can skip the block.
 * @param block - Reasoning message block.
 * @returns An assistant content block, or `null` to skip.
 */
function reasoningToContentBlock(block: MessageBlock & { type: 'reasoning' }): AssistantContentBlock | null {
  const signature = typeof block.metadata?.signature === 'string' ? block.metadata.signature : undefined;
  if (signature !== undefined) {
    return { type: 'thinking', thinking: block.content, signature };
  }
  if (block.content.length > 0) {
    return { type: 'text', text: block.content };
  }
  return null;
}

/**
 * Build the Anthropic {@link MessageParam} entries for a single assistant turn.
 *
 * Returns an assistant message followed by an optional user message containing
 * matched tool results. Orphan tool outputs (no corresponding tool call in the
 * same turn) are appended to the assistant content as text blocks.
 * @param blocks - All blocks belonging to the assistant message.
 * @returns Zero, one, or two {@link MessageParam} entries.
 */
function buildAssistantParams(blocks: MessageBlock[]): MessageParam[] {
  const contentBlocks: AssistantContentBlock[] = [];
  const toolOutputs: CollectedToolOutput[] = [];
  const toolCallIds = new Set<string>();

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        if (block.content.length > 0) {
          contentBlocks.push({ type: 'text', text: block.content });
        }
        break;
      }
      case 'reasoning': {
        const converted = reasoningToContentBlock(block);
        if (converted !== null) contentBlocks.push(converted);
        break;
      }
      case 'tool_call': {
        toolCallIds.add(block.toolCallId);
        const toolUseBlock: ToolUseBlockParam = {
          type: 'tool_use',
          id: block.toolCallId,
          name: block.name,
          input: block.args,
        };
        contentBlocks.push(toolUseBlock);
        break;
      }
      case 'tool_output': {
        toolOutputs.push({ toolCallId: block.toolCallId, content: block.output, isError: block.isError });
        break;
      }
      // image, document, attachment — skip (not meaningful in assistant history)
    }
  }

  // Separate matched tool outputs (have a corresponding tool_call) from
  // orphans (arrived without a matching call in the same turn).
  const matchedOutputs = toolOutputs.filter((o) => toolCallIds.has(o.toolCallId));
  const orphanOutputs = toolOutputs.filter((o) => !toolCallIds.has(o.toolCallId));

  // Orphan tool outputs have no valid tool_use to reference. Emit as text
  // blocks so the context is not silently lost.
  for (const orphan of orphanOutputs) {
    const label = orphan.isError ? 'Error' : 'Result';
    contentBlocks.push({ type: 'text', text: `[Tool ${label} ${orphan.toolCallId}]\n${orphan.content}` });
  }

  const result: MessageParam[] = [];

  if (contentBlocks.length > 0) {
    result.push({ role: 'assistant', content: contentBlocks });
  }

  // Tool results must follow the assistant message as a user turn containing
  // tool_result content blocks — one per matched output.
  if (matchedOutputs.length > 0) {
    const toolResultBlocks: ToolResultBlockParam[] = matchedOutputs.map((output) => ({
      type: 'tool_result',
      tool_use_id: output.toolCallId,
      content: output.isError ? `[Tool Error]\n${output.content}` : output.content,
      ...(output.isError ? { is_error: true } : {}),
    }));
    result.push({ role: 'user', content: toolResultBlocks });
  }

  return result;
}

/**
 * Convert an array of user {@link MessageBlock}s to the Anthropic `content` field value
 * for a user {@link MessageParam}.
 *
 * Applies the same conversion as {@link convertMessageHistory} does for user messages
 * in the history, making it reusable for the current-turn user message.
 *
 * - A single text block is returned as a plain string (keeps the wire format simple).
 * - Multiple blocks or any non-text block are returned as a {@link UserContentBlock} array.
 * - Empty text blocks are dropped.
 * @param blocks - Message blocks from the current user turn.
 * @returns The Anthropic `content` field value: a string or content block array.
 */
export function convertCurrentTurnBlocks(blocks: MessageBlock[]): string | UserContentBlock[] {
  const contentBlocks = blocks.map(userBlockToContentBlock).filter((b) => {
    return b.type !== 'text' || b.text.length > 0;
  });
  if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') {
    return contentBlocks[0].text;
  }
  return contentBlocks;
}

/**
 * Converts Makaio normalized message history to Anthropic {@link MessageParam} format.
 *
 * Anthropic differs from OpenAI in several key ways:
 * - System messages are top-level params (excluded from the output array).
 * - Assistant messages use a content block array (`text`, `tool_use`).
 * - Tool results are emitted as a `role: 'user'` message containing
 * `tool_result` content blocks, not as a separate `role: 'tool'` message.
 * - Reasoning blocks are emitted as native `thinking` blocks when
 * `block.metadata.signature` is present (captured from Anthropic
 * `signature_delta` events during streaming); without a signature they fall
 * back to `text` blocks so context is not silently lost.
 * @param history - Makaio normalized message array.
 * @returns Anthropic-formatted message params (system messages excluded).
 */
export function convertMessageHistory(history: Message[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of history) {
    const blocks = Array.isArray(msg.blocks) ? msg.blocks : [msg.blocks];

    if (msg.role === 'system') {
      // System messages are handled by buildMessageCreateRequest as a top-level
      // param — they must not appear in the messages array.
      continue;
    }

    if (msg.role === 'assistant') {
      result.push(...buildAssistantParams(blocks));
    } else {
      const content = convertCurrentTurnBlocks(blocks);
      if (typeof content === 'string' && content.length === 0) continue;
      if (Array.isArray(content) && content.length === 0) continue;
      result.push({ role: 'user', content });
    }
  }

  return result;
}
