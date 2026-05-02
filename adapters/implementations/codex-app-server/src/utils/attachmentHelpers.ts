/**
 * Helpers for converting message blocks to Codex `UserInput` items.
 *
 * Kept separate from the connector to respect its max-lines budget and to
 * allow independent testing of the conversion logic.
 */

import { serializeBlockToText } from '@makaio/ai-adapters-core';
import type { MessageBlock } from '@makaio/contracts/shared';
import type { UserInput } from '../protocol/generated/v2/index.js';

/**
 * Decode a base64-encoded string to UTF-8 text.
 *
 * Uses Web-standard `TextDecoder`/`atob` so this works in both browser and
 * Node.js (16+) environments. Returns an empty string on malformed input
 * rather than propagating the `DOMException` thrown by `atob`.
 * @param data - Base64-encoded string.
 * @returns Decoded UTF-8 string, or `''` if `data` is not valid base64.
 */
function decodeBase64Text(data: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

/**
 * Return true when a MIME type represents plain-text or text-like content
 * that Codex can consume as a text input rather than a binary blob.
 * @param mimeType - MIME type string to test, or `undefined`.
 * @returns `true` when the MIME type is considered text-based.
 */
function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith('text/')) return true;
  const textApplicationTypes = [
    'application/json',
    'application/xml',
    'application/sql',
    'application/graphql',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
  ];
  return textApplicationTypes.includes(mimeType);
}

/**
 * Convert a single {@link MessageBlock} to a Codex {@link UserInput}, or
 * `null` when the block type has no Codex representation (e.g. tool_call).
 *
 * Dispatch rules:
 * - `text` → `{ type: 'text' }`
 * - `image` with URL source → `{ type: 'image' }`
 * - `image` with base64 source → `null` (unsupported; Codex only accepts local paths via attachment blocks)
 * - `attachment` with image MIME → `{ type: 'localImage' }` (uses `filePath`)
 * - `attachment` with text-like MIME → decoded `{ type: 'text' }`
 * - `attachment` otherwise → `{ type: 'text' }` placeholder via `serializeBlockToText`
 * - all other block types → `null` (skipped)
 * @param block - The normalized message block to convert.
 * @returns A Codex `UserInput` or `null` if the block should be skipped.
 */
export function convertBlockToUserInput(block: MessageBlock): UserInput | null {
  if (block.type === 'text') {
    return { type: 'text', text: block.content };
  }

  if (block.type === 'image' && block.source.type === 'url') {
    return { type: 'image', url: block.source.url };
  }

  if (block.type === 'image' && block.source.type === 'base64') {
    // Base64 images are unsupported by Codex (only local paths via attachment blocks).
    return null;
  }

  if (block.type === 'attachment') {
    const mimeType = block.source.type === 'base64' ? block.source.mimeType : undefined;
    if (mimeType?.startsWith('image/')) {
      // Codex accepts server-side local image paths directly
      return { type: 'localImage', path: block.filePath };
    }
    if (isTextMimeType(mimeType) && block.source.type === 'base64') {
      // Decode text-based attachments and send as inline text
      return { type: 'text', text: decodeBase64Text(block.source.data) };
    }
    // Fallback: emit a placeholder describing the attachment
    return { type: 'text', text: serializeBlockToText(block) };
  }

  return null;
}
