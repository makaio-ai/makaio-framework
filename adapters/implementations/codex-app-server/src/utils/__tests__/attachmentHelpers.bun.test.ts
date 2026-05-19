/**
 * Tests for `convertBlockToUserInput`.
 *
 * Exercises the conversion from normalized {@link MessageBlock} values to
 * Codex {@link UserInput} items. No I/O, no bus — pure function.
 *
 * Key dispatch rules under test:
 * - `attachment` + `image/png` → `{ type: 'localImage', path: block.filePath }`
 * - `attachment` + `text/plain` (base64) → `{ type: 'text', text: decoded-utf8 }`
 * - `attachment` + unknown mimeType → `{ type: 'text', text: serializeBlockToText(block) }`
 * - `text` block → `{ type: 'text', text: block.content }`
 */

import { describe, it, expect } from 'bun:test';
import type { MessageBlock } from '@makaio/contracts/shared';
import { convertBlockToUserInput } from '../attachmentHelpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 string to base64 using Node's Buffer API.
 * @param text - UTF-8 string to encode.
 * @returns Base64-encoded string.
 */
function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('convertBlockToUserInput', () => {
  describe('text block', () => {
    it('returns { type: "text", text: block.content }', () => {
      const block: MessageBlock = { type: 'text', content: 'Hello, world!' };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'text', text: 'Hello, world!' });
    });
  });

  describe('attachment block — image MIME type', () => {
    it('returns { type: "localImage", path: block.filePath } for image/png', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'screenshot.png',
        filePath: '/server/uploads/screenshot.png',
        attachmentType: 'file',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/png' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'localImage', path: '/server/uploads/screenshot.png' });
    });

    it('returns { type: "localImage", path: block.filePath } for image/jpeg', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'photo.jpg',
        filePath: '/server/uploads/photo.jpg',
        attachmentType: 'file',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/jpeg' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'localImage', path: '/server/uploads/photo.jpg' });
    });
  });

  describe('attachment block — text-like MIME type', () => {
    it('returns decoded text for text/plain base64 content', () => {
      const content = 'Hello from file';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'notes.txt',
        filePath: '/server/uploads/notes.txt',
        attachmentType: 'file',
        source: { type: 'base64', data: toBase64(content), mimeType: 'text/plain' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'text', text: content });
    });

    it('returns decoded text for application/json base64 content', () => {
      const content = '{"key":"value"}';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'data.json',
        filePath: '/server/uploads/data.json',
        attachmentType: 'file',
        source: { type: 'base64', data: toBase64(content), mimeType: 'application/json' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'text', text: content });
    });
  });

  describe('attachment block — unknown MIME type', () => {
    it('falls back to serializeBlockToText placeholder for application/octet-stream', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'archive.bin',
        filePath: '/server/uploads/archive.bin',
        attachmentType: 'file',
        source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
      };

      const result = convertBlockToUserInput(block);

      // serializeBlockToText emits "[Attachment: {fileName}]" when displayName is absent
      expect(result).toEqual({ type: 'text', text: '[Attachment: archive.bin]' });
    });

    it('uses displayName in the fallback placeholder when present', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'archive.bin',
        filePath: '/server/uploads/archive.bin',
        displayName: 'My Binary Archive',
        attachmentType: 'file',
        source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'text', text: '[Attachment: My Binary Archive]' });
    });
  });

  describe('image block', () => {
    it('returns { type: "image", url } for URL source', () => {
      const block: MessageBlock = {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.png' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toEqual({ type: 'image', url: 'https://example.com/image.png' });
    });

    it('returns null for base64 image source (unsupported by Codex)', () => {
      const block: MessageBlock = {
        type: 'image',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/png' },
      };

      const result = convertBlockToUserInput(block);

      expect(result).toBeNull();
    });
  });

  describe('non-renderable block types', () => {
    it('returns null for tool_call blocks', () => {
      const block: MessageBlock = {
        type: 'tool_call',
        toolCallId: 'call_abc',
        name: 'readFile',
        args: { path: '/tmp/foo.txt' },
      };

      expect(convertBlockToUserInput(block)).toBeNull();
    });

    it('returns null for tool_output blocks', () => {
      const block: MessageBlock = {
        type: 'tool_output',
        toolCallId: 'call_abc',
        output: 'file contents here',
      };

      expect(convertBlockToUserInput(block)).toBeNull();
    });
  });
});
