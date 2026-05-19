import { describe, it, expect } from 'bun:test';
import type { NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { extractNonTextParts } from '../src/utils/extractNonTextParts.js';

/**
 * Minimal helper to build a NormalizedMessageInput for tests.
 * @param blocks - Message blocks to include in the normalized input
 */
function msg(blocks: NormalizedMessageInput['blocks']): NormalizedMessageInput {
  return { role: 'user', blocks };
}

describe('extractNonTextParts', () => {
  it('returns empty array when blocks is empty', () => {
    expect(extractNonTextParts(msg([]))).toEqual([]);
  });

  it('returns empty array for text-only blocks (text blocks are not non-text parts)', () => {
    expect(extractNonTextParts(msg([{ type: 'text', content: 'hello' }]))).toEqual([]);
  });

  it('converts image base64 blocks to inlineData parts', () => {
    const result = extractNonTextParts(
      msg([{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'image/png' } }]),
    );
    expect(result).toEqual([{ inlineData: { data: 'abc123', mimeType: 'image/png' } }]);
  });

  it('converts image URL blocks to fileData parts', () => {
    const result = extractNonTextParts(
      msg([{ type: 'image', source: { type: 'url', url: 'http://example.com/img.png', mimeType: 'image/jpeg' } }]),
    );
    expect(result).toEqual([{ fileData: { fileUri: 'http://example.com/img.png', mimeType: 'image/jpeg' } }]);
  });

  it('converts document base64 blocks to inlineData parts', () => {
    const result = extractNonTextParts(
      msg([{ type: 'document', source: { type: 'base64', data: 'pdfdata', mimeType: 'application/pdf' } }]),
    );
    expect(result).toEqual([{ inlineData: { data: 'pdfdata', mimeType: 'application/pdf' } }]);
  });

  it('converts attachment blocks with image mimeType to inlineData parts', () => {
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'photo.png',
          filePath: '/tmp/photo.png',
          attachmentType: 'file',
          source: { type: 'base64', data: 'imgdata', mimeType: 'image/png' },
        },
      ]),
    );
    expect(result).toEqual([{ inlineData: { data: 'imgdata', mimeType: 'image/png' } }]);
  });

  it('converts attachment blocks with PDF mimeType to inlineData parts', () => {
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'report.pdf',
          filePath: '/tmp/report.pdf',
          attachmentType: 'file',
          source: { type: 'base64', data: 'pdfdata', mimeType: 'application/pdf' },
        },
      ]),
    );
    expect(result).toEqual([{ inlineData: { data: 'pdfdata', mimeType: 'application/pdf' } }]);
  });

  it('decodes text attachment blocks (text/plain) as text parts in live turns', () => {
    const textContent = 'hello world from attachment';
    const encoded = Buffer.from(textContent, 'utf-8').toString('base64');
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'notes.txt',
          filePath: '/tmp/notes.txt',
          attachmentType: 'file',
          source: { type: 'base64', data: encoded, mimeType: 'text/plain' },
        },
      ]),
    );
    expect(result).toEqual([{ text: textContent }]);
  });

  it('decodes text attachment blocks (text/markdown) as text parts in live turns', () => {
    const mdContent = '# Title\n\nSome markdown.';
    const encoded = Buffer.from(mdContent, 'utf-8').toString('base64');
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'readme.md',
          filePath: '/tmp/readme.md',
          attachmentType: 'file',
          source: { type: 'base64', data: encoded, mimeType: 'text/markdown' },
        },
      ]),
    );
    expect(result).toEqual([{ text: mdContent }]);
  });

  it('decodes text attachment blocks (application/json) as text parts in live turns', () => {
    const jsonContent = '{"key":"value"}';
    const encoded = Buffer.from(jsonContent, 'utf-8').toString('base64');
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'data.json',
          filePath: '/tmp/data.json',
          attachmentType: 'file',
          source: { type: 'base64', data: encoded, mimeType: 'application/json' },
        },
      ]),
    );
    expect(result).toEqual([{ text: jsonContent }]);
  });

  it('sends binary attachment blocks (application/octet-stream) as inlineData without decoding', () => {
    const binaryData = 'AQIDBAU='; // raw binary base64: bytes 1,2,3,4,5
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'data.bin',
          filePath: '/tmp/data.bin',
          attachmentType: 'file',
          source: { type: 'base64', data: binaryData, mimeType: 'application/octet-stream' },
        },
      ]),
    );
    expect(result).toEqual([{ inlineData: { data: binaryData, mimeType: 'application/octet-stream' } }]);
  });

  it('skips attachment blocks with URL source (only base64 is supported)', () => {
    const result = extractNonTextParts(
      msg([
        { type: 'text', content: 'hi' },
        {
          type: 'attachment',
          fileName: 'file.txt',
          filePath: '/tmp/file.txt',
          attachmentType: 'file',
          source: { type: 'url', url: 'http://example.com/file.txt' },
        },
      ]),
    );
    // text block is not a non-text part; URL attachment is skipped
    expect(result).toEqual([]);
  });

  it('normalizes mixed-case MIME with parameters for attachment blocks', () => {
    const result = extractNonTextParts(
      msg([
        {
          type: 'attachment',
          fileName: 'photo.png',
          filePath: '/tmp/photo.png',
          attachmentType: 'file',
          source: { type: 'base64', data: 'imgdata', mimeType: 'IMAGE/PNG; charset=binary' },
        },
      ]),
    );
    expect(result).toEqual([{ inlineData: { data: 'imgdata', mimeType: 'image/png' } }]);
  });
});
