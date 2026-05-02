import { serializeBlockToText, isTextLikeMimeType, normalizeMimeType } from '@makaio/ai-adapters-core';
import type { ContentSource, MessageBlock } from '@makaio/contracts/shared';
import type {
  BetaBase64ImageSource,
  BetaContentBlockParam,
  BetaDocumentBlockParam,
  BetaImageBlockParam,
  BetaTextBlockParam,
} from '@makaio/client-claude-code';
import { decodeBase64Text } from './decodeBase64Text.js';

/** Valid Anthropic image media types derived from the SDK schema. */
const VALID_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const satisfies readonly BetaBase64ImageSource['media_type'][];

/**
 * Resolve a MIME type against an allowed set of literals, returning a fallback
 * when absent or unrecognised.
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
 * Convert a {@link ContentSource} to an Anthropic {@link BetaImageBlockParam}.
 * @param source - The content source for the image block.
 * @param normalizedMimeType - Pre-normalized MIME type to use instead of `source.mimeType`.
 *   When provided, skips normalization inside this function and uses the caller's value.
 * @returns A `BetaImageBlockParam`.
 */
function imageSourceToParam(source: ContentSource, normalizedMimeType?: string): BetaImageBlockParam {
  if (source.type === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        data: source.data,
        media_type: resolveMediaType(
          normalizedMimeType ?? normalizeMimeType(source.mimeType),
          VALID_IMAGE_MEDIA_TYPES,
          'image/jpeg',
        ),
      },
    };
  }
  return { type: 'image', source: { type: 'url', url: source.url } };
}

/**
 * Build a text document source for Anthropic API.
 * @param data - UTF-8 text content.
 * @returns A text document source object.
 */
function buildTextDocumentSource(data: string): BetaDocumentBlockParam['source'] {
  return {
    type: 'text' as const,
    data,
    media_type: 'text/plain',
  };
}

/**
 * Convert a {@link ContentSource} to an Anthropic {@link BetaDocumentBlockParam}.
 *
 * Selects the appropriate Anthropic source shape:
 * - `text/plain` maps to a plain-text source (`type: 'text'`).
 * - Other types (or absent/unknown MIME) default to a base64 PDF source.
 * @param source - The content source for the document block.
 * @returns A `BetaDocumentBlockParam`.
 */
function documentSourceToParam(source: ContentSource): BetaDocumentBlockParam {
  if (source.type === 'base64') {
    const normalizedMimeType = normalizeMimeType(source.mimeType);
    if (normalizedMimeType === 'text/plain') {
      return {
        type: 'document',
        source: buildTextDocumentSource(decodeBase64Text(source.data)),
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
 * Convert an `attachment` {@link MessageBlock} to an Anthropic content block.
 *
 * Dispatch is based on the normalized source `mimeType`:
 * - Anthropic-supported image types (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) → {@link BetaImageBlockParam}
 * - Unsupported image variants (e.g. `image/svg+xml`) fall through to the text path
 * - `application/pdf` → {@link BetaDocumentBlockParam} (base64-encoded)
 * - `text/*` or text-like `application/*` (json, xml, sql, graphql …) → {@link BetaDocumentBlockParam} with plain-text source (decoded)
 * - Other / URL source → {@link BetaTextBlockParam} via `serializeBlockToText`
 * @param block - Attachment message block.
 * @returns A content block param suitable for the Anthropic API.
 */
function attachmentToContentBlock(block: MessageBlock & { type: 'attachment' }): BetaContentBlockParam {
  const { source } = block;

  if (source.type === 'base64') {
    const normalizedMimeType = normalizeMimeType(source.mimeType);

    if ((VALID_IMAGE_MEDIA_TYPES as readonly string[]).includes(normalizedMimeType)) {
      return imageSourceToParam(source, normalizedMimeType);
    }

    if (normalizedMimeType === 'application/pdf') {
      return {
        type: 'document',
        source: { type: 'base64', data: source.data, media_type: 'application/pdf' },
      };
    }

    if (isTextLikeMimeType(normalizedMimeType)) {
      return {
        type: 'document',
        source: buildTextDocumentSource(decodeBase64Text(source.data)),
      };
    }
  }

  return { type: 'text', text: serializeBlockToText(block) };
}

/**
 * Converts normalized message blocks to Anthropic SDK content blocks.
 *
 * Handles text, image, document, and attachment blocks. Attachment blocks
 * are mapped based on their source mimeType to the appropriate SDK type.
 * Non-content blocks (reasoning, tool_call, tool_output) fall back to text.
 * @param blocks - Array of normalized message blocks
 * @returns Array of Anthropic SDK content block params
 */
export function blocksToContentBlocks(blocks: MessageBlock[]): BetaContentBlockParam[] {
  return blocks.map((block): BetaContentBlockParam => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.content } satisfies BetaTextBlockParam;
      case 'image': {
        const normalizedMime = block.source.type === 'base64' ? normalizeMimeType(block.source.mimeType) : undefined;
        return imageSourceToParam(block.source, normalizedMime);
      }
      case 'document':
        return documentSourceToParam(block.source);
      case 'attachment':
        return attachmentToContentBlock(block);
      default:
        return {
          type: 'text',
          text: serializeBlockToText(block),
        } satisfies BetaTextBlockParam;
    }
  });
}
