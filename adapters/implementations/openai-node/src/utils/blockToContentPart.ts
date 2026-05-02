import path from 'node:path';
import type { ChatCompletionContentPart, ChatCompletionContentPartImage } from 'openai/resources/index.js';
import type { MessageBlock } from '@makaio/contracts/shared';
import { serializeBlockToText, isTextLikeMimeType, normalizeMimeType } from '@makaio/ai-adapters-core';

/** Minimal extension→MIME map used when attachments omit explicit MIME type metadata. */
const ATTACHMENT_EXTENSION_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.csv': 'text/csv',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
};

/**
 * Build a data URI string for inline base64 content.
 * @param mimeType - The MIME type of the content.
 * @param data - The base64-encoded data string.
 * @returns A `data:{mimeType};base64,{data}` URI string.
 */
function buildDataUri(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/**
 * Infer MIME type from attachment filename when source metadata is absent.
 * @param fileName - Attachment file name.
 * @returns Inferred MIME type, or undefined when extension is unknown.
 */
function inferMimeTypeFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) return undefined;
  const ext = path.extname(fileName).toLowerCase();
  if (!ext) return undefined;
  return ATTACHMENT_EXTENSION_MIME[ext];
}

/**
 * Convert a {@link MessageBlock} to an OpenAI {@link ChatCompletionContentPart}.
 *
 * Mapping rules:
 * - `text` → `{ type: 'text', text: block.content }`
 * - `image` (base64) → `{ type: 'image_url', image_url: { url: 'data:{mimeType};base64,{data}' } }`
 * - `image` (url) → `{ type: 'image_url', image_url: { url: block.source.url } }`
 * - `document` (base64) → `{ type: 'file', file: { file_data: 'data:{mimeType};base64,{data}', filename: 'document' } }`
 * - `attachment` with image MIME → `{ type: 'image_url', ... }`
 * - `attachment` with PDF MIME → `{ type: 'file', file: { file_data: ..., filename } }`
 * - `attachment` with text-like MIME (base64) → decoded UTF-8 as `{ type: 'text', text }`
 * - All other blocks → `{ type: 'text', text: serializeBlockToText(block) }`
 * @param block - The message block to convert.
 * @returns A `ChatCompletionContentPart` suitable for the OpenAI messages API.
 */
export function blockToContentPart(block: MessageBlock): ChatCompletionContentPart {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.content };

    case 'image': {
      if (block.source.type === 'base64') {
        const mimeType = block.source.mimeType ?? 'image/png';
        const url: ChatCompletionContentPartImage['image_url'] = {
          url: buildDataUri(mimeType, block.source.data),
        };
        return { type: 'image_url', image_url: url };
      }
      // url source
      return { type: 'image_url', image_url: { url: block.source.url } };
    }

    case 'document': {
      if (block.source.type === 'base64') {
        const mimeType = block.source.mimeType ?? 'application/pdf';
        return {
          type: 'file',
          file: {
            file_data: buildDataUri(mimeType, block.source.data),
            filename: 'document',
          },
        };
      }
      // URL-based documents fall back to text placeholder
      return { type: 'text', text: serializeBlockToText(block) };
    }

    case 'attachment': {
      const { source, fileName } = block;

      if (source.type === 'base64') {
        const inferredMimeType = source.mimeType ?? inferMimeTypeFromFileName(fileName);
        const normalizedMimeType = normalizeMimeType(inferredMimeType);

        if (normalizedMimeType.startsWith('image/')) {
          return { type: 'image_url', image_url: { url: buildDataUri(normalizedMimeType, source.data) } };
        }

        if (normalizedMimeType === 'application/pdf') {
          return {
            type: 'file',
            file: { file_data: buildDataUri(normalizedMimeType, source.data), filename: fileName },
          };
        }

        if (isTextLikeMimeType(normalizedMimeType)) {
          // Defensive decoding: wrap in try/catch to handle invalid base64
          let decodedText: string;
          try {
            decodedText = Buffer.from(source.data, 'base64').toString('utf-8');
          } catch {
            // Return empty string on invalid base64
            decodedText = '';
          }
          return { type: 'text', text: decodedText };
        }

        // Unknown binary without a reliable MIME classification falls back to text placeholder.
        // This preserves context without guessing unsafe content-part shapes.
        return { type: 'text', text: serializeBlockToText(block) };
      }

      // URL-based attachments — no reliable way to send inline; use placeholder
      return { type: 'text', text: serializeBlockToText(block) };
    }

    default:
      // reasoning, tool_call, tool_output
      return { type: 'text', text: serializeBlockToText(block) };
  }
}

/**
 * Convert an array of {@link MessageBlock}s to `ChatCompletionContentPart[]`,
 * filtering out parts that produce empty text.
 * @param blocks - The blocks to convert.
 * @returns A non-empty array of content parts, or an empty array if all parts are empty.
 */
export function blocksToContentParts(blocks: MessageBlock[]): ChatCompletionContentPart[] {
  return blocks.map(blockToContentPart).filter((part) => {
    if (part.type === 'text') {
      return part.text.length > 0;
    }
    return true;
  });
}
