/**
 * Tests for `blocksToContentBlocks`.
 *
 * Exercises the conversion from normalized {@link MessageBlock} arrays to
 * Anthropic SDK {@link BetaContentBlockParam} arrays. No I/O, no bus — pure function.
 *
 * Key dispatch rules under test:
 * - `text` block → `BetaTextBlockParam`
 * - `image` block (base64) → `BetaImageBlockParam`
 * - `document` block (base64) → `BetaDocumentBlockParam`
 * - `attachment` + `image/png` → `BetaImageBlockParam`
 * - `attachment` + `application/pdf` → `BetaDocumentBlockParam` (base64 source)
 * - `attachment` + `text/plain` → `BetaDocumentBlockParam` (plain-text source, utf8-decoded)
 * - `attachment` + `application/octet-stream` → `BetaTextBlockParam` via `serializeBlockToText`
 * - `attachment` + `application/typescript` → `BetaDocumentBlockParam` (text-like)
 * - `attachment` + `application/json` → `BetaDocumentBlockParam` (text-like)
 * - mixed block array → correct output in order
 */

import { describe, it, expect } from 'bun:test';
import type { MessageBlock } from '@makaio/contracts/shared';
import { blocksToContentBlocks } from '../blocksToContentBlocks.js';

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

describe('blocksToContentBlocks', () => {
  describe('text block', () => {
    it('returns a BetaTextBlockParam with the correct text', () => {
      const blocks: MessageBlock[] = [{ type: 'text', content: 'Hello, world!' }];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text', text: 'Hello, world!' });
    });
  });

  describe('image block', () => {
    it('converts a base64 image source to BetaImageBlockParam', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'image',
          source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/png' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'image',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', media_type: 'image/png' },
      });
    });
  });

  describe('document block', () => {
    it('converts a base64 document source to BetaDocumentBlockParam', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'document',
          source: { type: 'base64', data: 'cGRmZGF0YQ==', mimeType: 'application/pdf' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'document',
        source: { type: 'base64', data: 'cGRmZGF0YQ==', media_type: 'application/pdf' },
      });
    });
  });

  describe('attachment block — image MIME types', () => {
    it('converts image/png attachment to BetaImageBlockParam with Base64ImageSource', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'photo.png',
          filePath: '/uploads/photo.png',
          attachmentType: 'file',
          source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/png' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'image',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', media_type: 'image/png' },
      });
    });

    it('converts image/jpeg attachment to BetaImageBlockParam', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'photo.jpg',
          filePath: '/uploads/photo.jpg',
          attachmentType: 'file',
          source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/jpeg' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'image',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', media_type: 'image/jpeg' },
      });
    });
  });

  describe('attachment block — PDF MIME type', () => {
    it('converts application/pdf attachment to BetaDocumentBlockParam with base64 PDF source', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'report.pdf',
          filePath: '/uploads/report.pdf',
          attachmentType: 'file',
          source: { type: 'base64', data: 'cGRmZGF0YQ==', mimeType: 'application/pdf' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'document',
        source: { type: 'base64', data: 'cGRmZGF0YQ==', media_type: 'application/pdf' },
      });
    });
  });

  describe('attachment block — text-like MIME types', () => {
    it('converts text/plain attachment to BetaDocumentBlockParam with PlainTextSource (utf8-decoded)', () => {
      // 'aGVsbG8=' is base64 for 'hello'
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'readme.txt',
          filePath: '/uploads/readme.txt',
          attachmentType: 'file',
          source: { type: 'base64', data: 'aGVsbG8=', mimeType: 'text/plain' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'document',
        source: { type: 'text', data: 'hello', media_type: 'text/plain' },
      });
    });

    it('converts application/json attachment to BetaDocumentBlockParam with PlainTextSource', () => {
      const jsonContent = '{"key":"value"}';
      const encoded = toBase64(jsonContent);
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'data.json',
          filePath: '/uploads/data.json',
          attachmentType: 'file',
          source: { type: 'base64', data: encoded, mimeType: 'application/json' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'document',
        source: { type: 'text', data: jsonContent, media_type: 'text/plain' },
      });
    });

    it('normalizes text/typescript to text-like and returns BetaDocumentBlockParam with PlainTextSource', () => {
      const tsContent = 'export const x = 1;';
      const encoded = toBase64(tsContent);
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'util.ts',
          filePath: '/uploads/util.ts',
          attachmentType: 'file',
          source: { type: 'base64', data: encoded, mimeType: 'text/typescript' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'document',
        source: { type: 'text', data: tsContent, media_type: 'text/plain' },
      });
    });
  });

  describe('attachment block — unknown / binary MIME type', () => {
    it('falls back to BetaTextBlockParam via serializeBlockToText for application/octet-stream', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'archive.bin',
          filePath: '/uploads/archive.bin',
          attachmentType: 'file',
          source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text', text: '[Attachment: archive.bin]' });
    });

    it('falls back to BetaTextBlockParam and uses displayName when present', () => {
      const blocks: MessageBlock[] = [
        {
          type: 'attachment',
          fileName: 'archive.bin',
          filePath: '/uploads/archive.bin',
          displayName: 'My Binary File',
          attachmentType: 'file',
          source: { type: 'base64', data: 'YmluYXJ5ZGF0YQ==', mimeType: 'application/octet-stream' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'text', text: '[Attachment: My Binary File]' });
    });
  });

  describe('mixed block array', () => {
    it('converts each block to its corresponding param type, preserving order', () => {
      const helloBase64 = toBase64('Hello from file');
      const blocks: MessageBlock[] = [
        { type: 'text', content: 'See the attached files:' },
        {
          type: 'attachment',
          fileName: 'photo.png',
          filePath: '/uploads/photo.png',
          attachmentType: 'file',
          source: { type: 'base64', data: 'aW1nZGF0YQ==', mimeType: 'image/png' },
        },
        {
          type: 'attachment',
          fileName: 'notes.txt',
          filePath: '/uploads/notes.txt',
          attachmentType: 'file',
          source: { type: 'base64', data: helloBase64, mimeType: 'text/plain' },
        },
        {
          type: 'attachment',
          fileName: 'report.pdf',
          filePath: '/uploads/report.pdf',
          attachmentType: 'file',
          source: { type: 'base64', data: 'cGRmZGF0YQ==', mimeType: 'application/pdf' },
        },
      ];

      const result = blocksToContentBlocks(blocks);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ type: 'text', text: 'See the attached files:' });
      expect(result[1]).toEqual({
        type: 'image',
        source: { type: 'base64', data: 'aW1nZGF0YQ==', media_type: 'image/png' },
      });
      expect(result[2]).toEqual({
        type: 'document',
        source: { type: 'text', data: 'Hello from file', media_type: 'text/plain' },
      });
      expect(result[3]).toEqual({
        type: 'document',
        source: { type: 'base64', data: 'cGRmZGF0YQ==', media_type: 'application/pdf' },
      });
    });
  });
});
