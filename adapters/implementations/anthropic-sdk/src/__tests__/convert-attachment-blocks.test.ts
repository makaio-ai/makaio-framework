/**
 * Tests for the `attachment` block dispatch in `userBlockToContentBlock`
 * (Anthropic SDK adapter).
 *
 * Exercises the MIME-type-driven mapping from an `attachment` MessageBlock to
 * the correct Anthropic content block param type. No bus, no I/O — pure function.
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@makaio/contracts/shared';
import { convertMessageHistory } from '../utils/convertMessageHistory.js';

describe('convertMessageHistory — user attachment blocks (Anthropic)', () => {
  it('converts an image/* attachment to a native ImageBlockParam', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'photo.png',
            filePath: '/home/user/photo.png',
            source: { type: 'base64', data: 'imgdata==', mimeType: 'image/png' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data: 'imgdata==', media_type: 'image/png' } }],
    });
  });

  it('converts an application/pdf attachment to a base64 DocumentBlockParam', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'report.pdf',
            filePath: '/home/user/report.pdf',
            source: { type: 'base64', data: 'pdfdata==', mimeType: 'application/pdf' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'document', source: { type: 'base64', data: 'pdfdata==', media_type: 'application/pdf' } }],
    });
  });

  it('converts a text/plain attachment to a decoded plain-text DocumentBlockParam', () => {
    // 'aGVsbG8=' is base64 for 'hello'
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'readme.txt',
            filePath: '/home/user/readme.txt',
            source: { type: 'base64', data: 'aGVsbG8=', mimeType: 'text/plain' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'document', source: { type: 'text', data: 'hello', media_type: 'text/plain' } }],
    });
  });

  it('converts an application/json attachment to a decoded plain-text DocumentBlockParam', () => {
    const jsonContent = '{"key":"value"}';
    const encoded = Buffer.from(jsonContent).toString('base64');
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'data.json',
            filePath: '/home/user/data.json',
            source: { type: 'base64', data: encoded, mimeType: 'application/json' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [{ type: 'document', source: { type: 'text', data: jsonContent, media_type: 'text/plain' } }],
    });
  });

  it('falls back to a serialized text string for attachments with an unrecognised binary MIME type', () => {
    // A single text block is returned as a plain string by convertCurrentTurnBlocks.
    const filePath = '/home/user/archive.zip';
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'archive.zip',
            filePath,
            source: { type: 'base64', data: 'zipdata==', mimeType: 'application/zip' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe('string');
    expect(result[0].content).toContain('archive.zip');
    expect(result[0].content).not.toContain(filePath);
  });

  it('falls back to a serialized text string for attachments with a URL source', () => {
    // A single text block is returned as a plain string by convertCurrentTurnBlocks.
    const filePath = '/home/user/doc.pdf';
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'doc.pdf',
            filePath,
            source: { type: 'url', url: 'https://example.com/doc.pdf' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe('string');
    expect(result[0].content).toContain('doc.pdf');
    expect(result[0].content).not.toContain(filePath);
  });

  it('converts a text/plain attachment as a decoded document block in mixed content', () => {
    // 'dGVzdA==' is base64 for 'test'
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'text', content: 'See attachment:' },
          {
            type: 'attachment',
            fileName: 'file.txt',
            filePath: '/home/user/file.txt',
            source: { type: 'base64', data: 'dGVzdA==', mimeType: 'text/plain' },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'See attachment:' },
        { type: 'document', source: { type: 'text', data: 'test', media_type: 'text/plain' } },
      ],
    });
  });
});
