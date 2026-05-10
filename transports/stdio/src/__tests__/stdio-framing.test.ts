import { describe, expect, it } from 'vitest';
import { decodeBusChunk, encodeBusMessage } from '../stdio-framing.js';

describe('encodeBusMessage', () => {
  it('produces a newline-terminated JSON string', () => {
    const result = encodeBusMessage({ type: 'ping' });
    expect(result).toBe('{"type":"ping"}\n');
  });

  it('is parseable as valid JSON after stripping the newline', () => {
    const message = { namespace: 'bus', event: 'hello', payload: { x: 1 } };
    const encoded = encodeBusMessage(message);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(JSON.parse(encoded.trimEnd())).toEqual(message);
  });
});

describe('decodeBusChunk', () => {
  it('parses a complete single message', () => {
    const { messages, remaining } = decodeBusChunk('{"type":"ping"}\n', '');
    expect(messages).toEqual([{ type: 'ping' }]);
    expect(remaining).toBe('');
  });

  it('parses multiple messages arriving in one chunk', () => {
    const chunk = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';
    const { messages, remaining } = decodeBusChunk(chunk, '');
    expect(messages).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    expect(remaining).toBe('');
  });

  it('returns partial data as remaining buffer when line is incomplete', () => {
    const { messages, remaining } = decodeBusChunk('{"type":"par', '');
    expect(messages).toHaveLength(0);
    expect(remaining).toBe('{"type":"par');
  });

  it('handles empty lines gracefully without adding them to messages', () => {
    const chunk = '{"type":"a"}\n\n{"type":"b"}\n';
    const { messages, remaining } = decodeBusChunk(chunk, '');
    expect(messages).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(remaining).toBe('');
  });

  it('reassembles a message split across two chunks', () => {
    const firstChunk = '{"type":"split';
    const { messages: firstMessages, remaining: firstRemaining } = decodeBusChunk(firstChunk, '');
    expect(firstMessages).toHaveLength(0);
    expect(firstRemaining).toBe('{"type":"split');

    const secondChunk = '"}\n';
    const { messages: secondMessages, remaining: secondRemaining } = decodeBusChunk(secondChunk, firstRemaining);
    expect(secondMessages).toEqual([{ type: 'split' }]);
    expect(secondRemaining).toBe('');
  });

  it('carries over a non-empty buffer prefix when combining with new chunk', () => {
    const { messages, remaining } = decodeBusChunk('ld"}\n', '{"type":"wor');
    expect(messages).toEqual([{ type: 'world' }]);
    expect(remaining).toBe('');
  });
});
