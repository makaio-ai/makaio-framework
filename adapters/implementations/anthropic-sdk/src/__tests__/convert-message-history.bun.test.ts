/**
 * Tests for convertMessageHistory (Anthropic SDK adapter).
 *
 * Exercises the mapping from Makaio normalized Message[] to Anthropic
 * MessageParam[].  No bus, no I/O — pure function.
 */

import { describe, it, expect } from 'bun:test';
import type { Message, MessageBlock } from '@makaio/contracts/shared';
import { convertMessageHistory, convertCurrentTurnBlocks } from '../utils/convertMessageHistory.js';

describe('convertMessageHistory (Anthropic)', () => {
  describe('role filtering', () => {
    it('excludes system messages from the output array', () => {
      const history: Message[] = [{ role: 'system', blocks: [{ type: 'text', content: 'Be helpful.' }] }];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(0);
    });

    it('handles an empty history', () => {
      expect(convertMessageHistory([])).toEqual([]);
    });
  });

  describe('user messages', () => {
    it('converts a user text block to a role:user string message', () => {
      const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', content: 'Hello' }] }];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('converts multiple text blocks within a user message to a content block array', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [
            { type: 'text', content: 'Line one' },
            { type: 'text', content: 'Line two' },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'Line one' },
          { type: 'text', text: 'Line two' },
        ],
      });
    });

    it('skips user messages whose blocks produce empty content', () => {
      const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', content: '' }] }];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(0);
    });
  });

  describe('user image blocks', () => {
    it('converts a base64 image block to a native Anthropic ImageBlockParam', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'image/png' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } }],
      });
    });

    it('falls back to image/jpeg when mimeType is not an accepted Anthropic image type', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'image/bmp' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      const block = (result[0].content as Array<{ type: string; source: { media_type: string } }>)[0];
      expect(block.source.media_type).toBe('image/jpeg');
    });

    it('falls back to image/jpeg when mimeType is not an accepted Anthropic type', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'image/tiff' } }],
        },
      ];

      const result = convertMessageHistory(history);

      const block = (result[0].content as Array<{ type: string; source: { media_type: string } }>)[0];
      expect(block.source.media_type).toBe('image/jpeg');
    });

    it('normalizes mixed-case mimeType with parameters to a valid Anthropic media_type', () => {
      // 'IMAGE/PNG; dpi=96' must normalize to 'image/png' before matching VALID_IMAGE_MEDIA_TYPES
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'IMAGE/PNG; dpi=96' } }],
        },
      ];

      const result = convertMessageHistory(history);

      const block = (result[0].content as Array<{ type: string; source: { media_type: string } }>)[0];
      expect(block.source.media_type).toBe('image/png');
    });

    it('converts a URL image block to a native Anthropic ImageBlockParam', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }],
      });
    });
  });

  describe('user document blocks', () => {
    it('converts a base64 document block to a native Anthropic DocumentBlockParam', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'document', source: { type: 'base64', data: 'pdfdata==', mimeType: 'application/pdf' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', data: 'pdfdata==', media_type: 'application/pdf' } }],
      });
    });

    it('converts a URL document block to a native Anthropic DocumentBlockParam', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'document', source: { type: 'url', url: 'https://example.com/doc.pdf' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/doc.pdf' } }],
      });
    });

    it('falls back to application/pdf for base64 document sources with unknown mimeType', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'document', source: { type: 'base64', data: 'csvdata==', mimeType: 'text/csv' } }],
        },
      ];

      const result = convertMessageHistory(history);

      const block = (result[0].content as Array<{ type: string; source: { type: string; media_type: string } }>)[0];
      expect(block.source.type).toBe('base64');
      expect(block.source.media_type).toBe('application/pdf');
    });

    it('converts a text/plain base64 document source to a PlainTextSource (type: text) with decoded data', () => {
      // 'aGVsbG8=' is base64 for 'hello'. The converter must decode the bytes before
      // passing them to PlainTextSource — the Anthropic API expects a plain UTF-8 string.
      const history: Message[] = [
        {
          role: 'user',
          blocks: [{ type: 'document', source: { type: 'base64', data: 'aGVsbG8=', mimeType: 'text/plain' } }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [{ type: 'document', source: { type: 'text', data: 'hello', media_type: 'text/plain' } }],
      });
    });
  });

  describe('user mixed content (text + image)', () => {
    it('converts mixed text and image blocks to a content block array', () => {
      const history: Message[] = [
        {
          role: 'user',
          blocks: [
            { type: 'text', content: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', data: 'imgdata==', mimeType: 'image/webp' } },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', source: { type: 'base64', data: 'imgdata==', media_type: 'image/webp' } },
        ],
      });
    });

    it('routes an image/svg+xml attachment to text (SVG is not a valid Anthropic image type)', () => {
      // SVG starts with 'image/' but is not in Anthropic's accepted image types.
      // It must NOT be silently rewritten to image/jpeg — route to text fallback instead.
      const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
      const history: Message[] = [
        {
          role: 'user',
          blocks: [
            {
              type: 'attachment',
              fileName: 'icon.svg',
              filePath: '/home/user/icon.svg',
              source: { type: 'base64', data: svgBase64, mimeType: 'image/svg+xml' },
              attachmentType: 'file',
            },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      const block = (result[0].content as Array<{ type: string }>)[0];
      // Must NOT produce an image block (which would silently send SVG bytes as JPEG)
      expect(block.type).not.toBe('image');
    });

    it('converts a text/plain attachment as a decoded plain-text document block in mixed content', () => {
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

    it('converts a text/plain attachment as a decoded plain-text document block with MIME parameters', () => {
      // 'dGVzdA==' is base64 for 'test'
      // Test that MIME type parameters like "; charset=utf-8" are handled correctly
      const history: Message[] = [
        {
          role: 'user',
          blocks: [
            { type: 'text', content: 'See attachment:' },
            {
              type: 'attachment',
              fileName: 'file.txt',
              filePath: '/home/user/file.txt',
              source: { type: 'base64', data: 'dGVzdA==', mimeType: 'text/plain; charset=utf-8' },
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

  describe('assistant text messages', () => {
    it('converts an assistant text block to a content block array', () => {
      const history: Message[] = [{ role: 'assistant', blocks: [{ type: 'text', content: 'Hi there.' }] }];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there.' }],
      });
    });

    it('skips empty text blocks', () => {
      const history: Message[] = [{ role: 'assistant', blocks: [{ type: 'text', content: '' }] }];

      // Produces no assistant message because all blocks are empty.
      const result = convertMessageHistory(history);

      expect(result).toHaveLength(0);
    });
  });

  describe('tool call + tool result round-trip', () => {
    it('produces assistant tool_use block followed by user tool_result message', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [
            { type: 'tool_call', toolCallId: 'tc-1', name: 'bash', args: { cmd: 'ls' } },
            { type: 'tool_output', toolCallId: 'tc-1', output: 'file.txt' },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tc-1', name: 'bash', input: { cmd: 'ls' } }],
      });
      expect(result[1]).toMatchObject({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'file.txt' }],
      });
    });

    it('prefixes error output with [Tool Error] in tool_result content', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [
            { type: 'tool_call', toolCallId: 'tc-err', name: 'bash', args: {} },
            { type: 'tool_output', toolCallId: 'tc-err', output: 'command failed', isError: true },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      const userMessage = result[1];
      expect(userMessage.role).toBe('user');
      const toolResult = (userMessage.content as Array<{ type: string; content?: string; is_error?: boolean }>)[0];
      expect(toolResult.content).toBe('[Tool Error]\ncommand failed');
      expect(toolResult.is_error).toBe(true);
    });

    it('converts an orphan tool_output (no matching tool_call) to an assistant text block', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [{ type: 'tool_output', toolCallId: 'orphan', output: 'orphan data' }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: '[Tool Result orphan]\norphan data' }],
      });
    });
  });

  describe('reasoning blocks', () => {
    it('converts a reasoning block with signature to a native ThinkingBlockParam', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [
            {
              type: 'reasoning',
              content: 'I am thinking.',
              metadata: { signature: 'sig-abc' },
            },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'I am thinking.', signature: 'sig-abc' }],
      });
    });

    it('converts a reasoning block without signature to a text block fallback', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [{ type: 'reasoning', content: 'Plain reasoning.' }],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'Plain reasoning.' }],
      });
    });

    it('skips a reasoning block when content is empty and no signature is present', () => {
      const history: Message[] = [
        {
          role: 'assistant',
          blocks: [
            { type: 'reasoning', content: '' },
            { type: 'text', content: 'Answer.' },
          ],
        },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(1);
      // Only the text block should appear — the empty reasoning block is dropped.
      const blocks = result[0].content as Array<{ type: string }>;
      expect(blocks.every((b) => b.type !== 'thinking')).toBe(true);
    });
  });

  describe('convertCurrentTurnBlocks (current-turn multimodal)', () => {
    it('returns a plain string for a single text block (common case)', () => {
      const blocks: MessageBlock[] = [{ type: 'text', content: 'Hello' }];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toBe('Hello');
    });

    it('converts a single image block to a native ImageBlockParam array', () => {
      const blocks: MessageBlock[] = [
        { type: 'image', source: { type: 'base64', data: 'imgdata==', mimeType: 'image/png' } },
      ];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toEqual([
        { type: 'image', source: { type: 'base64', data: 'imgdata==', media_type: 'image/png' } },
      ]);
    });

    it('converts mixed text + image blocks to a content block array', () => {
      const blocks: MessageBlock[] = [
        { type: 'text', content: 'What is in this image?' },
        { type: 'image', source: { type: 'base64', data: 'imgdata==', mimeType: 'image/webp' } },
      ];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toEqual([
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: { type: 'base64', data: 'imgdata==', media_type: 'image/webp' } },
      ]);
    });

    it('converts a document block to a native DocumentBlockParam array', () => {
      const blocks: MessageBlock[] = [
        { type: 'document', source: { type: 'base64', data: 'pdfdata==', mimeType: 'application/pdf' } },
      ];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toEqual([
        { type: 'document', source: { type: 'base64', data: 'pdfdata==', media_type: 'application/pdf' } },
      ]);
    });

    it('drops empty text blocks and returns remaining content', () => {
      const blocks: MessageBlock[] = [
        { type: 'text', content: '' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
      ];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toEqual([{ type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } }]);
    });

    it('returns an empty array when all blocks are empty text', () => {
      const blocks: MessageBlock[] = [{ type: 'text', content: '' }];

      const result = convertCurrentTurnBlocks(blocks);

      expect(result).toEqual([]);
    });
  });

  describe('mixed content sequences', () => {
    it('converts a sequence of user → assistant → user messages preserving order', () => {
      const history: Message[] = [
        { role: 'user', blocks: [{ type: 'text', content: 'Hello' }] },
        { role: 'assistant', blocks: [{ type: 'text', content: 'Hi!' }] },
        { role: 'user', blocks: [{ type: 'text', content: 'Thanks' }] },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ role: 'user', content: 'Hello' });
      expect(result[1]).toMatchObject({ role: 'assistant' });
      expect(result[2]).toMatchObject({ role: 'user', content: 'Thanks' });
    });

    it('ignores system messages interspersed with user messages', () => {
      const history: Message[] = [
        { role: 'system', blocks: [{ type: 'text', content: 'System context.' }] },
        { role: 'user', blocks: [{ type: 'text', content: 'User message.' }] },
        { role: 'assistant', blocks: [{ type: 'text', content: 'Response.' }] },
      ];

      const result = convertMessageHistory(history);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ role: 'user', content: 'User message.' });
      expect(result[1]).toMatchObject({ role: 'assistant' });
    });
  });
});
