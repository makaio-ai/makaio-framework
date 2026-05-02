import type { ToolCallResponseInfo } from '@google/gemini-cli-core';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { MessageBlock } from '@makaio/contracts/shared';
import { isTextLikeMimeType, normalizeMimeType } from '@makaio/ai-adapters-core';

type GeminiPart = ToolCallResponseInfo['responseParts'][number];

/**
 * Block types that carry binary/media content via a ContentSource.
 */
type MediaBlock = Extract<MessageBlock, { type: 'image' | 'document' }>;

/**
 * Attachment block type (image/PDF-capable binary or text content).
 */
type AttachmentBlock = Extract<MessageBlock, { type: 'attachment' }>;

/**
 * Extract non-text content from a NormalizedMessageInput and convert to Gemini Part[].
 *
 * Handles image and document blocks with base64 or URL sources.
 * Attachment blocks are converted based on their MIME type:
 * - image/* and application/pdf → inlineData parts
 * - text-like MIME types (text/plain, text/markdown, application/json, etc.) → base64-decoded text parts
 *   (live turns have no history-replay path, so text attachments must be decoded here)
 * - other binary MIME types → inlineData parts (sent natively, not decoded to avoid corruption)
 * @param message - The normalized message input
 * @returns Array of Gemini Part objects for non-text-block content (may be empty)
 */
export function extractNonTextParts(message: NormalizedMessageInput): GeminiPart[] {
  if (!Array.isArray(message.blocks) || message.blocks.length === 0) {
    return [];
  }

  const parts: GeminiPart[] = [];

  for (const block of message.blocks) {
    if (block.type === 'image' || block.type === 'document') {
      const part = mediaBlockToGeminiPart(block as MediaBlock);
      if (part) {
        parts.push(part);
      }
      continue;
    }

    if (block.type === 'attachment') {
      const attachmentBlock = block as AttachmentBlock;
      if (attachmentBlock.source.type === 'base64') {
        const normalizedMimeType = normalizeMimeType(attachmentBlock.source.mimeType);
        if (normalizedMimeType.startsWith('image/') || normalizedMimeType === 'application/pdf') {
          parts.push({
            inlineData: {
              data: attachmentBlock.source.data,
              mimeType: normalizedMimeType,
            },
          });
        } else if (isTextLikeMimeType(normalizedMimeType)) {
          // Text attachments in live turns: decode base64 and send as a text part.
          // Unlike history replay (convertMessageHistory.ts → attachmentBlockToPart), there
          // is no upstream path that handles these — they would otherwise be silently dropped.
          try {
            parts.push({ text: Buffer.from(attachmentBlock.source.data, 'base64').toString('utf-8') });
          } catch (error) {
            console.warn('[Gemini SDK] Invalid base64 attachment payload in live turn', {
              fileName: attachmentBlock.fileName,
              mimeType: normalizedMimeType,
              error: error instanceof Error ? error.message : String(error),
            });
            parts.push({ text: '' });
          }
        } else {
          // Non-text binary: send as inlineData so Gemini handles it natively (UTF-8 decoding would corrupt it)
          parts.push({
            inlineData: {
              data: attachmentBlock.source.data,
              mimeType: normalizedMimeType,
            },
          });
        }
      }
      continue;
    }
  }

  return parts;
}

/**
 * Convert a media MessageBlock (image/document) to a Gemini Part.
 * @param block - Image or document block with a ContentSource
 * @returns Gemini Part with inlineData or fileData, or undefined if unsupported
 */
function mediaBlockToGeminiPart(block: MediaBlock): GeminiPart | undefined {
  const { source } = block;

  switch (source.type) {
    case 'base64':
      return {
        inlineData: {
          data: source.data,
          mimeType: normalizeMimeType(source.mimeType),
        },
      };
    case 'url':
      return {
        fileData: {
          fileUri: source.url,
          mimeType: normalizeMimeType(source.mimeType),
        },
      };
  }
}
