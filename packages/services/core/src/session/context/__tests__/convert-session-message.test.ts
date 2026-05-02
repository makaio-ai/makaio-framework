import { describe, it, expect } from 'vitest';
import type { SessionMessage } from '@makaio/contracts';
import { convertSessionMessage } from '../convert-session-message.js';

describe('convertSessionMessage', () => {
  const createBaseMessage = (blocks: SessionMessage['blocks']): SessionMessage => ({
    messageId: 'msg-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    role: 'assistant',
    contentText: 'test',
    blocks,
    timestamp: Date.now(),
  });

  it('should convert text blocks directly', () => {
    const msg = createBaseMessage([{ type: 'text', content: 'Hello world' }]);

    const result = convertSessionMessage(msg);

    expect(result.role).toBe('assistant');
    expect(result.blocks).toEqual([{ type: 'text', content: 'Hello world' }]);
  });

  it('should pass through reasoning blocks directly', () => {
    const msg = createBaseMessage([{ type: 'reasoning', content: 'Let me think about this...' }]);

    const result = convertSessionMessage(msg);

    expect(result.blocks).toEqual([{ type: 'reasoning', content: 'Let me think about this...' }]);
  });

  it('should pass through tool_call blocks directly', () => {
    const msg = createBaseMessage([
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'bash',
        args: { command: 'ls -la', cwd: '/tmp' },
      },
    ]);

    const result = convertSessionMessage(msg);

    expect(result.blocks).toEqual([
      {
        type: 'tool_call',
        toolCallId: 'tool-1',
        name: 'bash',
        args: { command: 'ls -la', cwd: '/tmp' },
      },
    ]);
  });

  it('should pass through tool_output blocks directly', () => {
    const msg = createBaseMessage([
      {
        type: 'tool_output',
        toolCallId: 'tool-1',
        output: 'file1.txt\nfile2.txt',
      },
    ]);

    const result = convertSessionMessage(msg);

    expect(result.blocks).toEqual([
      {
        type: 'tool_output',
        toolCallId: 'tool-1',
        output: 'file1.txt\nfile2.txt',
      },
    ]);
  });

  it('should pass through mixed block types directly', () => {
    const msg = createBaseMessage([
      { type: 'text', content: 'I will run a command.' },
      { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_output', toolCallId: 'tool-1', output: 'result' },
      { type: 'text', content: 'Done!' },
    ]);

    const result = convertSessionMessage(msg);

    expect(result.blocks).toEqual([
      { type: 'text', content: 'I will run a command.' },
      { type: 'tool_call', toolCallId: 'tool-1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_output', toolCallId: 'tool-1', output: 'result' },
      { type: 'text', content: 'Done!' },
    ]);
  });

  it('should preserve user role', () => {
    const msg: SessionMessage = {
      ...createBaseMessage([{ type: 'text', content: 'User message' }]),
      role: 'user',
    };

    const result = convertSessionMessage(msg);

    expect(result.role).toBe('user');
  });
});
