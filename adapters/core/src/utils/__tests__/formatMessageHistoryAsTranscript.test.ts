import { describe, it, expect } from 'vitest';
import type { Message } from '@makaio/contracts/shared';
import { formatMessageHistoryAsTranscript } from '../formatMessageHistoryAsTranscript.js';

describe('formatMessageHistoryAsTranscript', () => {
  it('formats text-only conversation', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Hello' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Hi there!' }] },
    ];
    expect(formatMessageHistoryAsTranscript(history)).toBe('User: Hello\nAssistant: Hi there!');
  });

  it('formats reasoning blocks with prefix', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'reasoning', content: 'Let me think...' }],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Reasoning]');
    expect(result).toContain('Let me think...');
  });

  it('formats tool_call blocks with name and args', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_call', toolCallId: 'tc-1', name: 'bash', args: { cmd: 'ls' } }],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Tool: bash]');
    expect(result).toContain('"cmd": "ls"');
  });

  it('formats tool_output blocks with result', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_output', toolCallId: 'tc-1', output: 'file.txt' }],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Tool Result]');
    expect(result).toContain('file.txt');
  });

  it('formats tool_output error blocks', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [{ type: 'tool_output', toolCallId: 'tc-1', output: 'not found', isError: true }],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Tool Error]');
  });

  it('formats media blocks as placeholders', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          { type: 'image', source: { type: 'url', url: 'http://example.com/img.png' } },
          { type: 'document', source: { type: 'base64', data: 'abc123', mimeType: 'application/pdf' } },
          {
            type: 'attachment',
            fileName: 'file.txt',
            filePath: '/tmp/file.txt',
            source: { type: 'base64', data: 'dGVzdA==', mimeType: 'text/plain' },
            attachmentType: 'file' as const,
          },
        ],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Image]');
    expect(result).toContain('[Document]');
    expect(result).toContain('[Attachment: file.txt]');
  });

  it('handles mixed blocks in a single message', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'text', content: 'I will run a command.' },
          { type: 'tool_call', toolCallId: 'tc-1', name: 'bash', args: { cmd: 'ls' } },
          { type: 'tool_output', toolCallId: 'tc-1', output: 'result' },
        ],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('I will run a command.');
    expect(result).toContain('[Tool: bash]');
    expect(result).toContain('[Tool Result]');
  });

  it('uses default user role when role is undefined', () => {
    const history: Message[] = [{ blocks: [{ type: 'text', content: 'Hello' }] }];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result.startsWith('User:')).toBe(true);
  });

  it('capitalizes role labels correctly', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'Question' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Answer' }] },
      { role: 'system', blocks: [{ type: 'text', content: 'Instruction' }] },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('User: Question');
    expect(result).toContain('Assistant: Answer');
    expect(result).toContain('System: Instruction');
  });

  it('handles attachment with displayName', () => {
    const history: Message[] = [
      {
        role: 'user',
        blocks: [
          {
            type: 'attachment',
            fileName: 'file.txt',
            filePath: '/tmp/very-long-path/to/file.txt',
            source: { type: 'base64', data: 'dGVzdA==', mimeType: 'text/plain' },
            displayName: 'file.txt',
            attachmentType: 'file' as const,
          },
        ],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('[Attachment: file.txt]');
  });

  it('handles single block (not in array)', () => {
    const history: Message[] = [{ role: 'user', blocks: { type: 'text', content: 'Hello' } }];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toBe('User: Hello');
  });

  it('formats multiple messages with newline separation', () => {
    const history: Message[] = [
      { role: 'user', blocks: [{ type: 'text', content: 'First' }] },
      { role: 'assistant', blocks: [{ type: 'text', content: 'Second' }] },
      { role: 'user', blocks: [{ type: 'text', content: 'Third' }] },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toBe('User: First\nAssistant: Second\nUser: Third');
  });

  it('joins multiple blocks with newlines within same message', () => {
    const history: Message[] = [
      {
        role: 'assistant',
        blocks: [
          { type: 'text', content: 'First block' },
          { type: 'text', content: 'Second block' },
        ],
      },
    ];
    const result = formatMessageHistoryAsTranscript(history);
    expect(result).toContain('First block\nSecond block');
  });
});
