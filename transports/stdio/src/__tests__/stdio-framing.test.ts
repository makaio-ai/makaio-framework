import { createJsonlDecoder } from '@makaio/subprocess';
import { describe, expect, it } from 'vitest';
import { encodeBusMessage } from '../stdio-framing.js';

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

  it('round-trips through the JSONL decoder, one message per line', () => {
    const messages = [{ type: 'a' }, { type: 'b', payload: { text: 'Grüße 💡' } }, { type: 'c' }];
    const decoder = createJsonlDecoder({ finalLine: 'discard' });

    const batch = decoder.push(Buffer.from(messages.map(encodeBusMessage).join(''), 'utf8'));

    expect(batch.messages).toEqual(messages);
    expect(batch.malformedLineCount).toBe(0);
    // Every encoded message is newline-terminated, so nothing is left at the end.
    expect(decoder.end().discardedChars).toBe(0);
  });

  it('encodes a payload containing newlines on a single line', () => {
    const encoded = encodeBusMessage({ type: 'event', payload: { text: 'line one\nline two' } });

    expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
  });
});
