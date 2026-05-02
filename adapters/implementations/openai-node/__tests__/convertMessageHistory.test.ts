import { describe, it, expect } from 'vitest';
import type { Message } from '@makaio/contracts/shared';
import { convertMessageHistory } from '../src/utils/convertMessageHistory.js';

describe('convertMessageHistory (OpenAI)', () => {
  it('converts text-only messages', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Hi there!' }] },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);
  });

  it('produces tool_calls on assistant messages', () => {
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
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check.',
      tool_calls: [
        {
          id: 'tc-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/foo"}' },
        },
      ],
    });
  });

  it('emits role: tool messages for tool_output blocks', () => {
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
      tool_calls: [{ id: 'tc-1' }],
    });
    expect(result[1]).toEqual({
      role: 'tool',
      tool_call_id: 'tc-1',
      content: 'file.txt',
    });
  });

  it('includes reasoning blocks as text content', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'reasoning', content: 'Thinking about this...' },
          { type: 'text', content: 'Here is my answer.' },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'Thinking about this...\nHere is my answer.',
    });
  });

  it('handles multiple tool calls and outputs', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_call', toolCallId: 'tc-1', name: 'read_file', args: { path: '/a' } },
          { type: 'tool_call', toolCallId: 'tc-2', name: 'read_file', args: { path: '/b' } },
          { type: 'tool_output', toolCallId: 'tc-1', output: 'content a' },
          { type: 'tool_output', toolCallId: 'tc-2', output: 'content b' },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toHaveLength(3); // 1 assistant + 2 tool
    expect(result[0]).toMatchObject({
      role: 'assistant',
      tool_calls: expect.arrayContaining([
        { id: 'tc-1', type: 'function', function: expect.any(Object) },
        { id: 'tc-2', type: 'function', function: expect.any(Object) },
      ]),
    });
    expect(result[1]).toMatchObject({ role: 'tool', tool_call_id: 'tc-1' });
    expect(result[2]).toMatchObject({ role: 'tool', tool_call_id: 'tc-2' });
  });

  it('converts user messages with mixed blocks to native content parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'text', content: 'Hello' },
          { type: 'image', source: { type: 'url', url: 'http://example.com/img.png' } },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'image_url', image_url: { url: 'http://example.com/img.png' } },
      ],
    });
  });

  it('handles assistant message with no text (tool_calls only)', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_call', toolCallId: 'tc-1', name: 'bash', args: { cmd: 'ls' } }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc-1' }],
    });
  });

  it('does not emit empty assistant messages for media-only blocks', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'image', source: { type: 'url', url: 'http://example.com/a.png' } }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([]);
  });

  it('converts document blocks in user history to native file content parts', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [{ type: 'document', source: { type: 'base64', data: 'abc', mimeType: 'application/pdf' } }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'file', file: { file_data: 'data:application/pdf;base64,abc', filename: 'document' } }],
      },
    ]);
  });

  it('routes attachment blocks by mimeType to the correct content part shape', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'report.pdf',
            filePath: '/tmp/report.pdf',
            source: { type: 'base64', data: 'abc', mimeType: 'application/pdf' },
            attachmentType: 'file',
          },
          {
            type: 'attachment',
            fileName: 'notes.json',
            filePath: '/tmp/notes.json',
            source: {
              type: 'base64',
              data: Buffer.from('{"ok":true}').toString('base64'),
              mimeType: 'application/json',
            },
            attachmentType: 'file',
          },
        ],
      },
    ];

    const result = convertMessageHistory(history);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'file',
          file: { file_data: 'data:application/pdf;base64,abc', filename: 'report.pdf' },
        },
        {
          type: 'text',
          text: '{"ok":true}',
        },
      ],
    });
  });

  it('serializes non-text user blocks to preserve context', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'reasoning', content: 'Imported note' },
          { type: 'tool_output', toolCallId: 'tc-9', output: 'cached value' },
        ],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      {
        role: 'user',
        content: 'Imported note\n[Tool Result tc-9]\ncached value',
      },
    ]);
  });

  it('falls back orphan assistant tool_output to assistant text and skips invalid tool role messages', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_output', toolCallId: 'orphan-call', output: 'orphan result' }],
      },
    ];
    const result = convertMessageHistory(history);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: '[Tool Result orphan-call]\norphan result',
      },
    ]);
  });

  it('preserves tool_output error semantics for matched and orphan outputs', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'tool_call', toolCallId: 'tc-1', name: 'bash', args: { cmd: 'ls' } },
          { type: 'tool_output', toolCallId: 'tc-1', output: 'permission denied', isError: true },
          { type: 'tool_output', toolCallId: 'tc-orphan', output: 'orphan failure', isError: true },
        ],
      },
    ];

    const result = convertMessageHistory(history);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: '[Tool Error tc-orphan]\norphan failure',
        tool_calls: [
          {
            id: 'tc-1',
            type: 'function',
            function: { name: 'bash', arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'tc-1',
        content: '[Tool Error]\npermission denied',
      },
    ]);
  });
});
