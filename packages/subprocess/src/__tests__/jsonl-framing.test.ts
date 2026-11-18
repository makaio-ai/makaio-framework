import { describe, expect, it } from 'vitest';
import { createJsonlDecoder, describeJsonlDrops } from '../jsonl-framing.js';

describe('createJsonlDecoder', () => {
  describe('framing', () => {
    it('decodes complete lines and skips blank ones', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });

      const batch = decoder.push('{"a":1}\n\n  \n{"b":2}\n');

      expect(batch.messages).toEqual([{ a: 1 }, { b: 2 }]);
      expect(batch.malformedLineCount).toBe(0);
      expect(batch.oversizedLineCount).toBe(0);
    });

    it('reassembles a line split across string chunks', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });

      expect(decoder.push('{"type":"sp').messages).toEqual([]);
      expect(decoder.push('lit"}\n{"x"').messages).toEqual([{ type: 'split' }]);
      expect(decoder.push(':1}\n').messages).toEqual([{ x: 1 }]);
    });

    it('accepts CRLF line endings', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });

      expect(decoder.push('{"a":1}\r\n').messages).toEqual([{ a: 1 }]);
    });

    it('delivers a multibyte character split at every byte offset intact', () => {
      const message = { text: 'Grüße 💡 € 你好' };
      const bytes = Buffer.from(JSON.stringify(message) + '\n', 'utf8');

      for (let offset = 1; offset < bytes.length; offset += 1) {
        const decoder = createJsonlDecoder({ finalLine: 'discard' });
        const first = decoder.push(bytes.subarray(0, offset));
        const second = decoder.push(bytes.subarray(offset));

        expect([...first.messages, ...second.messages]).toEqual([message]);
        expect(first.malformedLineCount + second.malformedLineCount).toBe(0);
      }
    });

    it('delivers a multibyte character fed one byte at a time intact', () => {
      const message = { text: '💡€' };
      const bytes = Buffer.from(JSON.stringify(message) + '\n', 'utf8');
      const decoder = createJsonlDecoder({ finalLine: 'discard' });

      const messages = [...bytes].flatMap((byte) => decoder.push(Buffer.from([byte])).messages);

      expect(messages).toEqual([message]);
    });
  });

  describe('malformed lines', () => {
    it('counts a malformed line and keeps decoding', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });

      const batch = decoder.push('not-json token=secret-value\n{"after":true}\n');

      expect(batch.messages).toEqual([{ after: true }]);
      expect(batch.malformedLineCount).toBe(1);
    });

    it('carries no line content in its result or its diagnostic', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });

      const batch = decoder.push('{"apiKey":"secret-value"\n');
      const end = decoder.end();
      const diagnostic = describeJsonlDrops(batch);

      expect(batch.malformedLineCount).toBe(1);
      expect(JSON.stringify(batch)).not.toContain('secret-value');
      expect(JSON.stringify(end)).not.toContain('secret-value');
      expect(diagnostic).toBe('1 malformed JSONL line(s)');
    });
  });

  describe('maximum line length', () => {
    it('drops and counts a complete line over the maximum', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard', maxLineLength: 16 });

      const batch = decoder.push(`{"long":"${'x'.repeat(32)}"}\n{"ok":1}\n`);

      expect(batch.messages).toEqual([{ ok: 1 }]);
      expect(batch.oversizedLineCount).toBe(1);
      expect(batch.malformedLineCount).toBe(0);
    });

    it('stops buffering an over-length line before its newline and resumes after it', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard', maxLineLength: 16 });

      const first = decoder.push(`{"long":"${'x'.repeat(12)}`);
      const second = decoder.push('x'.repeat(64));
      const third = decoder.push('"}\n{"ok":1}\n');

      expect(first.oversizedLineCount).toBe(1);
      expect(second.oversizedLineCount).toBe(0);
      expect(third.oversizedLineCount).toBe(0);
      expect(third.malformedLineCount).toBe(0);
      expect(third.messages).toEqual([{ ok: 1 }]);
      // The skipped line was counted once; nothing of it is left to discard.
      expect(decoder.end().discardedChars).toBe(0);
    });

    it('accepts a line of exactly the maximum length', () => {
      const line = JSON.stringify({ v: 'y'.repeat(8) });
      const decoder = createJsonlDecoder({ finalLine: 'discard', maxLineLength: line.length });

      expect(decoder.push(`${line}\n`).messages).toEqual([{ v: 'y'.repeat(8) }]);
    });

    it('rejects a maximum that is not a positive integer', () => {
      expect(() => createJsonlDecoder({ finalLine: 'discard', maxLineLength: 0 })).toThrow(RangeError);
      expect(() => createJsonlDecoder({ finalLine: 'discard', maxLineLength: 1.5 })).toThrow(RangeError);
    });
  });

  describe('end of input', () => {
    it('parses an unterminated final line under the parse policy', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });

      expect(decoder.push('{"a":1}\n{"last":true}').messages).toEqual([{ a: 1 }]);
      const end = decoder.end();

      expect(end.messages).toEqual([{ last: true }]);
      expect(end.discardedChars).toBe(0);
    });

    it('counts an unterminated final line that is not JSON under the parse policy', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });
      decoder.push('{"cut":');

      const end = decoder.end();

      expect(end.messages).toEqual([]);
      expect(end.malformedLineCount).toBe(1);
    });

    it('discards and counts an unterminated final line under the discard policy', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });
      decoder.push('{"a":1}\n{"last":true}');

      const end = decoder.end();

      expect(end.messages).toEqual([]);
      expect(end.malformedLineCount).toBe(0);
      expect(end.discardedChars).toBe('{"last":true}'.length);
      expect(describeJsonlDrops(end)).toBe('an unterminated final line (13 chars)');
    });

    it('flushes an incomplete UTF-8 sequence at the end instead of dropping it silently', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });
      const euro = Buffer.from('€', 'utf8');
      decoder.push(Buffer.concat([Buffer.from('{"v":"'), euro.subarray(0, 2)]));

      const end = decoder.end();

      // The truncated character becomes a replacement character, so the line is
      // still unterminated JSON and is counted rather than lost without a trace.
      expect(end.messages).toEqual([]);
      expect(end.malformedLineCount).toBe(1);
    });

    it('treats a whitespace-only rest as no line', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });
      decoder.push('{"a":1}\n  ');

      expect(decoder.end()).toEqual({ messages: [], malformedLineCount: 0, oversizedLineCount: 0, discardedChars: 0 });
    });

    it('is idempotent: a second end() delivers nothing again', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });
      decoder.push('{"last":true}');

      expect(decoder.end().messages).toEqual([{ last: true }]);
      expect(decoder.end()).toEqual({ messages: [], malformedLineCount: 0, oversizedLineCount: 0, discardedChars: 0 });
      expect(decoder.abandon()).toBe(0);
    });

    it('refuses input after the end', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });
      decoder.end();

      expect(() => decoder.push('{"late":true}\n')).toThrow('JSONL decoder has already ended');
    });
  });

  describe('abandon', () => {
    it('drops the buffered rest and reports its length', () => {
      const decoder = createJsonlDecoder({ finalLine: 'parse' });
      decoder.push('{"a":1}\n{"partial":');

      expect(decoder.abandon()).toBe('{"partial":'.length);
      // Abandoning is final: the rest is not parsed by a later end().
      expect(decoder.end().messages).toEqual([]);
      expect(decoder.abandon()).toBe(0);
    });

    it('counts a pending partial character in the dropped rest', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });
      decoder.push(Buffer.concat([Buffer.from('{"v":"'), Buffer.from('€', 'utf8').subarray(0, 1)]));

      expect(decoder.abandon()).toBe('{"v":"'.length + 1);
    });

    it('reports nothing when no rest is buffered', () => {
      const decoder = createJsonlDecoder({ finalLine: 'discard' });
      decoder.push('{"a":1}\n');

      expect(decoder.abandon()).toBe(0);
    });
  });
});

describe('describeJsonlDrops', () => {
  it('returns undefined when nothing was dropped', () => {
    expect(
      describeJsonlDrops({ messages: [], malformedLineCount: 0, oversizedLineCount: 0, discardedChars: 0 }),
    ).toBeUndefined();
  });

  it('names every kind of drop by count', () => {
    expect(describeJsonlDrops({ messages: [], malformedLineCount: 2, oversizedLineCount: 1, discardedChars: 5 })).toBe(
      '2 malformed JSONL line(s) and 1 over-length JSONL line(s) and an unterminated final line (5 chars)',
    );
  });
});
