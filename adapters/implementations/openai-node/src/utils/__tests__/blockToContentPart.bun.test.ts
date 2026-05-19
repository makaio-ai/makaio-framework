/**
 * Tests for `blockToContentPart`.
 *
 * Exercises the conversion from normalized {@link MessageBlock} values to
 * OpenAI {@link ChatCompletionContentPart} items. No I/O, no bus — pure function.
 *
 * Key dispatch rules under test:
 * - `text` block → `{ type: 'text', text: block.content }`
 * - `attachment` + `image/png` → `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`
 * - `attachment` + `application/pdf` → `{ type: 'file', file: { file_data: 'data:...', filename } }`
 * - `attachment` + `text/plain` (base64) → `{ type: 'text', text: decoded-utf8 }`
 * - `attachment` + unknown mimeType → `{ type: 'text', text: serializeBlockToText(block) }`
 */

import { describe, it, expect } from 'bun:test';
import type { MessageBlock } from '@makaio/contracts/shared';
import { blockToContentPart } from '../blockToContentPart.js';

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

describe('blockToContentPart', () => {
  describe('text block', () => {
    it('returns { type: "text", text: block.content }', () => {
      const block: MessageBlock = { type: 'text', content: 'Hello, world!' };

      const result = blockToContentPart(block);

      expect(result).toEqual({ type: 'text', text: 'Hello, world!' });
    });
  });

  describe('attachment block — image MIME type', () => {
    it('returns image_url content part with data URI for image/png', () => {
      const data = 'aW1nZGF0YQ==';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'screenshot.png',
        filePath: '/uploads/screenshot.png',
        attachmentType: 'file',
        source: { type: 'base64', data, mimeType: 'image/png' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${data}` },
      });
    });

    it('returns image_url content part with data URI for image/jpeg', () => {
      const data = 'aW1nZGF0YQ==';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'photo.jpg',
        filePath: '/uploads/photo.jpg',
        attachmentType: 'file',
        source: { type: 'base64', data, mimeType: 'image/jpeg' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${data}` },
      });
    });
  });

  describe('attachment block — PDF MIME type', () => {
    it('returns file content part with data URI and filename for application/pdf', () => {
      const data = 'cGRmZGF0YQ==';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'report.pdf',
        filePath: '/uploads/report.pdf',
        attachmentType: 'file',
        source: { type: 'base64', data, mimeType: 'application/pdf' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'file',
        file: {
          file_data: `data:application/pdf;base64,${data}`,
          filename: 'report.pdf',
        },
      });
    });
  });

  describe('attachment block — text-like MIME type', () => {
    it('returns decoded text for text/plain base64 content', () => {
      const content = 'Hello from file';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'notes.txt',
        filePath: '/uploads/notes.txt',
        attachmentType: 'file',
        source: { type: 'base64', data: toBase64(content), mimeType: 'text/plain' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({ type: 'text', text: content });
    });

    it('returns decoded text for application/json base64 content', () => {
      const content = '{"key":"value"}';
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'data.json',
        filePath: '/uploads/data.json',
        attachmentType: 'file',
        source: { type: 'base64', data: toBase64(content), mimeType: 'application/json' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({ type: 'text', text: content });
    });
  });

  describe('attachment block — unknown MIME type', () => {
    it('falls back to serializeBlockToText placeholder for application/octet-stream', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'archive.bin',
        filePath: '/uploads/archive.bin',
        attachmentType: 'file',
        source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
      };

      const result = blockToContentPart(block);

      // serializeBlockToText emits "[Attachment: {fileName}]" when displayName is absent
      expect(result).toEqual({ type: 'text', text: '[Attachment: archive.bin]' });
    });

    it('uses displayName in the fallback placeholder when present', () => {
      const block: MessageBlock = {
        type: 'attachment',
        fileName: 'archive.bin',
        filePath: '/uploads/archive.bin',
        displayName: 'My Binary Archive',
        attachmentType: 'file',
        source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({ type: 'text', text: '[Attachment: My Binary Archive]' });
    });
  });

  describe('image block', () => {
    it('returns image_url content part with data URI for base64 image source', () => {
      const data = 'aW1nZGF0YQ==';
      const block: MessageBlock = {
        type: 'image',
        source: { type: 'base64', data, mimeType: 'image/png' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${data}` },
      });
    });

    it('returns image_url content part with the original URL for url image source', () => {
      const block: MessageBlock = {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/image.png' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.png' },
      });
    });
  });

  describe('other block types', () => {
    it('falls back to serializeBlockToText text part for tool_call blocks', () => {
      const block: MessageBlock = {
        type: 'tool_call',
        toolCallId: 'call_abc',
        name: 'readFile',
        args: { path: '/tmp/foo.txt' },
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'text',
        text: '[Tool: readFile]\n{"path":"/tmp/foo.txt"}',
      });
    });

    it('falls back to serializeBlockToText text part for tool_output blocks', () => {
      const block: MessageBlock = {
        type: 'tool_output',
        toolCallId: 'call_abc',
        output: 'file contents here',
      };

      const result = blockToContentPart(block);

      expect(result).toEqual({
        type: 'text',
        text: '[Tool Result call_abc]\nfile contents here',
      });
    });
  });
});
