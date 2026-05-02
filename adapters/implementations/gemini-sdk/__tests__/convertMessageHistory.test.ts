import { describe, it, expect } from 'vitest';
import type { Message } from '@makaio/contracts/shared';
import { convertMessageHistory } from '../src/utils/convertMessageHistory.js';

describe('convertMessageHistory (Gemini)', () => {
  it('converts text-only messages', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Hi!' }] },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi!' }] },
    ]);
  });

  it('produces functionCall parts on model messages', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'text', content: 'Let me check.' },
          { type: 'tool_call', toolCallId: 'tc-1', name: 'read_file', args: { path: '/foo' } },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({
      role: 'model',
      parts: [{ text: 'Let me check.' }, { functionCall: { name: 'read_file', args: { path: '/foo' } } }],
    });
  });

  it('emits functionResponse as separate user message', () => {
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
      role: 'model',
      parts: [{ functionCall: { name: 'bash', args: { cmd: 'ls' } } }],
    });
    expect(result[1]).toMatchObject({
      role: 'user',
      parts: [{ functionResponse: { id: 'tc-1', name: 'bash', response: { output: 'file.txt' } } }],
    });
  });

  it('uses error response shape for failed tool outputs', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_call', toolCallId: 'tc-err', name: 'bash', args: { cmd: 'bad' } },
          { type: 'tool_output', toolCallId: 'tc-err', output: 'command failed', isError: true },
        ],
      },
    ];

    const result = convertMessageHistory(history);
    expect(result[1]).toMatchObject({
      role: 'user',
      parts: [{ functionResponse: { id: 'tc-err', name: 'bash', response: { error: 'command failed' } } }],
    });
  });

  it('resolves tool name for functionResponse via toolCallId map', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_call', toolCallId: 'tc-42', name: 'search', args: { query: 'test' } },
          { type: 'tool_output', toolCallId: 'tc-42', output: 'found results' },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    const responseParts = result[1].parts as Array<Record<string, unknown>>;
    const fnResponse = responseParts[0] as { functionResponse: { name: string } };
    expect(fnResponse.functionResponse.name).toBe('search');
  });

  it('resolves tool name across messages when output is separate', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_call', toolCallId: 'tc-99', name: 'read_file', args: { path: '/tmp/a' } }],
      },
      {
        role: 'assistant',
        blocks: [{ type: 'tool_output', toolCallId: 'tc-99', output: 'file content' }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: 'user',
      parts: [{ functionResponse: { name: 'read_file', response: { output: 'file content' } } }],
    });
  });

  it('falls back to text when tool_output has no matching tool_call', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_output', toolCallId: 'missing-call', output: 'orphan output', isError: true }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      {
        role: 'user',
        parts: [{ text: '[Tool Output missing-call (error)]\norphan output' }],
      },
    ]);
  });

  it('maps system role to user', () => {
    const history: Message[] = [{ role: 'system', blocks: [{ type: 'text', content: 'You are helpful.' }] }];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({ role: 'user' });
  });

  it('serializes tool_call as text when it appears on non-assistant messages', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [{ type: 'tool_call', toolCallId: 'tc-invalid', name: 'read_file', args: { path: '/tmp/a' } }],
      },
    ];

    expect(convertMessageHistory(history)).toEqual([
      {
        role: 'user',
        parts: [{ text: '[Tool Call tc-invalid from user: read_file]' }],
      },
    ]);
  });

  it('includes reasoning as text parts', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'reasoning', content: 'Let me think...' },
          { type: 'text', content: 'Answer.' },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({
      role: 'model',
      parts: [{ text: 'Let me think...' }, { text: 'Answer.' }],
    });
  });

  it('merges consecutive user messages into a single entry', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'First message' }] },
      { role: 'user', blocks: [{ type: 'text', content: 'Second message' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Reply' }] },
    ];
    const result = convertMessageHistory(history);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ text: 'First message' }, { text: 'Second message' }],
    });
    expect(result[1]).toEqual({ role: 'model', parts: [{ text: 'Reply' }] });
  });

  it('merges consecutive model messages into a single entry', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Hi' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Part 1.' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Part 2.' }] },
    ];
    const result = convertMessageHistory(history);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Part 1.' }, { text: 'Part 2.' }],
    });
  });

  it('merges user text with following functionResponse (both user-role)', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Context info' }] },
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_call', toolCallId: 'tc-merge', name: 'bash', args: { cmd: 'ls' } },
          { type: 'tool_output', toolCallId: 'tc-merge', output: 'result' },
        ],
      },
      { role: 'user', blocks: [{ type: 'text', content: 'Follow up' }] },
    ];
    const result = convertMessageHistory(history);
    // [user:Context] [model:functionCall] [user:functionResponse] [user:Follow up]
    // After merge: [user:Context] [model:functionCall] [user:functionResponse + Follow up]
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'Context info' }] });
    expect(result[1]).toMatchObject({ role: 'model' });
    expect(result[2].role).toBe('user');
    expect(result[2].parts).toHaveLength(2);
  });

  it('produces strictly alternating roles for complex history', () => {
    const history: Message[] = [
      { role: 'system', blocks: [{ type: 'text', content: 'System context' }] },
      { role: 'user', blocks: [{ type: 'text', content: 'User msg' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Reply' }] },
    ];
    const result = convertMessageHistory(history);
    // system maps to user, followed by user → two consecutive user entries → merged
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ text: 'System context' }, { text: 'User msg' }],
    });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
  });

  it('converts image URL blocks to fileData parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'text', content: 'Check this' },
          { type: 'image', source: { type: 'url', url: 'http://example.com/img.png', mimeType: 'image/png' } },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ text: 'Check this' }, { fileData: { fileUri: 'http://example.com/img.png', mimeType: 'image/png' } }],
    });
  });

  it('converts image base64 blocks to inlineData parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [{ type: 'image', source: { type: 'base64', data: 'abc123', mimeType: 'image/jpeg' } }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { data: 'abc123', mimeType: 'image/jpeg' } }],
    });
  });

  it('converts document URL blocks to fileData parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'document', source: { type: 'url', url: 'http://example.com/doc.pdf', mimeType: 'application/pdf' } },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ fileData: { fileUri: 'http://example.com/doc.pdf', mimeType: 'application/pdf' } }],
    });
  });

  it('converts attachment blocks with image mimeType to inlineData parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'photo.png',
            filePath: '/tmp/photo.png',
            attachmentType: 'file',
            source: { type: 'base64', data: 'imgdata', mimeType: 'image/png' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { data: 'imgdata', mimeType: 'image/png' } }],
    });
  });

  it('converts attachment blocks with PDF mimeType to inlineData parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'report.pdf',
            filePath: '/tmp/report.pdf',
            attachmentType: 'file',
            source: { type: 'base64', data: 'pdfdata', mimeType: 'application/pdf' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { data: 'pdfdata', mimeType: 'application/pdf' } }],
    });
  });

  it('decodes text attachment blocks as text parts', () => {
    const textContent = 'hello world';
    const encoded = Buffer.from(textContent, 'utf-8').toString('base64');
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'notes.txt',
            filePath: '/tmp/notes.txt',
            attachmentType: 'file',
            source: { type: 'base64', data: encoded, mimeType: 'text/plain' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ text: textContent }],
    });
  });

  it('skips attachment blocks with URL source', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'text', content: 'hi' },
          {
            type: 'attachment',
            fileName: 'file.txt',
            filePath: '/tmp/file.txt',
            attachmentType: 'file',
            source: { type: 'url', url: 'http://example.com/file.txt' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] });
  });

  it('sends binary attachments as inlineData instead of decoding to UTF-8 text', () => {
    // application/octet-stream is not text-like — must NOT be decoded to text
    // (UTF-8 decoding of arbitrary binary data corrupts it).
    const binaryData = 'AQIDBAU='; // raw binary base64: bytes 1,2,3,4,5
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'data.bin',
            filePath: '/tmp/data.bin',
            attachmentType: 'file',
            source: { type: 'base64', data: binaryData, mimeType: 'application/octet-stream' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { data: binaryData, mimeType: 'application/octet-stream' } }],
    });
  });

  it('normalizes mixed-case MIME with parameters for attachment blocks', () => {
    // 'IMAGE/PNG; charset=binary' must normalize to 'image/png' before matching
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'photo.png',
            filePath: '/tmp/photo.png',
            attachmentType: 'file',
            source: { type: 'base64', data: 'imgdata', mimeType: 'IMAGE/PNG; charset=binary' },
          },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { data: 'imgdata', mimeType: 'image/png' } }],
    });
  });
});
