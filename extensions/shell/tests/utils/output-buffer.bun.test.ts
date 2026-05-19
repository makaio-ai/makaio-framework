import { describe, it, expect, beforeEach } from 'bun:test';
import { OutputBuffer } from '../../src/utils/output-buffer.js';

describe('OutputBuffer', () => {
  let buffer: OutputBuffer;

  beforeEach(() => {
    buffer = new OutputBuffer({ maxSize: 1000 });
  });

  describe('append', () => {
    it('captures stdout chunks with timestamps', () => {
      buffer.append('stdout', 'hello world\n');

      const state = buffer.getState();
      expect(state.stdoutSize).toBe(12);
      expect(state.stderrSize).toBe(0);
      expect(state.totalSize).toBe(12);
      expect(state.truncated).toBe(false);
    });

    it('captures stderr chunks with timestamps', () => {
      buffer.append('stderr', 'error message\n');

      const state = buffer.getState();
      expect(state.stdoutSize).toBe(0);
      expect(state.stderrSize).toBe(14);
      expect(state.totalSize).toBe(14);
      expect(state.truncated).toBe(false);
    });

    it('accumulates multiple chunks', () => {
      buffer.append('stdout', 'line 1\n');
      buffer.append('stdout', 'line 2\n');
      buffer.append('stderr', 'err\n');

      const state = buffer.getState();
      expect(state.stdoutSize).toBe(14); // 'line 1\n' + 'line 2\n'
      expect(state.stderrSize).toBe(4); // 'err\n'
      expect(state.totalSize).toBe(18);
    });
  });

  describe('getLines', () => {
    it('returns stdout lines with line numbers', () => {
      buffer.append('stdout', 'first\nsecond\n');

      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        stream: 'stdout',
        content: 'first',
        lineNumber: 1,
      });
      expect(lines[1]).toEqual({
        stream: 'stdout',
        content: 'second',
        lineNumber: 2,
      });
    });

    it('returns stderr lines with line numbers', () => {
      buffer.append('stderr', 'error1\nerror2\n');

      const lines = buffer.getLines('stderr');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        stream: 'stderr',
        content: 'error1',
        lineNumber: 1,
      });
      expect(lines[1]).toEqual({
        stream: 'stderr',
        content: 'error2',
        lineNumber: 2,
      });
    });

    it('interleaves stdout and stderr chronologically for "both"', async () => {
      buffer.append('stdout', 'out1\n');
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 5));
      buffer.append('stderr', 'err1\n');
      await new Promise((r) => setTimeout(r, 5));
      buffer.append('stdout', 'out2\n');

      const lines = buffer.getLines('both');
      expect(lines).toHaveLength(3);
      expect(lines[0].content).toBe('out1');
      expect(lines[0].stream).toBe('stdout');
      expect(lines[1].content).toBe('err1');
      expect(lines[1].stream).toBe('stderr');
      expect(lines[2].content).toBe('out2');
      expect(lines[2].stream).toBe('stdout');
    });

    it('handles multiple lines in single chunk', () => {
      buffer.append('stdout', 'a\nb\nc\n');

      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(3);
      expect(lines.map((l) => l.content)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('partial line buffering', () => {
    it('buffers partial lines until newline received', () => {
      buffer.append('stdout', 'partial');
      expect(buffer.getLines('stdout')).toHaveLength(0);

      buffer.append('stdout', ' complete\n');
      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(1);
      expect(lines[0].content).toBe('partial complete');
    });

    it('flushes partial lines on flush call', () => {
      buffer.append('stdout', 'incomplete');
      expect(buffer.getLines('stdout')).toHaveLength(0);

      buffer.flush();
      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(1);
      expect(lines[0].content).toBe('incomplete');
    });

    it('handles mixed complete and partial lines', () => {
      buffer.append('stdout', 'complete\npartial');
      const lines1 = buffer.getLines('stdout');
      expect(lines1).toHaveLength(1);
      expect(lines1[0].content).toBe('complete');

      buffer.append('stdout', ' done\n');
      const lines2 = buffer.getLines('stdout');
      expect(lines2).toHaveLength(2);
      expect(lines2[1].content).toBe('partial done');
    });
  });

  describe('truncation (tail mode)', () => {
    it('truncates old content when maxSize exceeded', () => {
      const smallBuffer = new OutputBuffer({
        maxSize: 20,
        truncateMode: 'tail',
      });

      smallBuffer.append('stdout', 'line1\n'); // 6 chars
      smallBuffer.append('stdout', 'line2\n'); // 6 chars = 12 total
      smallBuffer.append('stdout', 'line3\n'); // 6 chars = 18 total
      smallBuffer.append('stdout', 'line4\n'); // 6 chars = 24 total, over limit

      const state = smallBuffer.getState();
      expect(state.truncated).toBe(true);
      expect(state.totalSize).toBeLessThanOrEqual(20);

      // Should keep recent content (line4, line3, line2 - approximately)
      const lines = smallBuffer.getLines('stdout');
      expect(lines.some((l) => l.content === 'line4')).toBe(true);
    });

    it('defaults to tail mode', () => {
      const defaultBuffer = new OutputBuffer({ maxSize: 10 });
      defaultBuffer.append('stdout', 'old\nnew\n');

      const state = defaultBuffer.getState();
      // With 8 chars total under 10 limit, no truncation yet
      expect(state.truncated).toBe(false);

      defaultBuffer.append('stdout', 'extra\n');
      // Now 14 chars, should truncate
      expect(defaultBuffer.getState().truncated).toBe(true);
    });
  });

  describe('getContent', () => {
    it('returns content with pagination info', () => {
      buffer.append('stdout', 'hello world\n');

      const result = buffer.getContent('stdout', 0, 100);
      expect(result.content).toBe('hello world\n');
      expect(result.stream).toBe('stdout');
      expect(result.offset).toBe(0);
      expect(result.totalSize).toBe(12);
      expect(result.hasMore).toBe(false);
    });

    it('supports offset and limit for pagination', () => {
      buffer.append('stdout', 'abcdefghij\n');

      const result = buffer.getContent('stdout', 3, 4);
      expect(result.content).toBe('defg');
      expect(result.offset).toBe(3);
      expect(result.hasMore).toBe(true);
    });

    it('returns interleaved content for "both"', async () => {
      buffer.append('stdout', 'out\n');
      await new Promise((r) => setTimeout(r, 5));
      buffer.append('stderr', 'err\n');

      const result = buffer.getContent('both', 0, 100);
      expect(result.content).toBe('out\nerr\n');
      expect(result.stream).toBe('interleaved');
    });

    it('handles offset beyond content length', () => {
      buffer.append('stdout', 'short\n');

      const result = buffer.getContent('stdout', 100, 10);
      expect(result.content).toBe('');
      expect(result.hasMore).toBe(false);
    });

    it('returns stderr content when requested', () => {
      buffer.append('stdout', 'out\n');
      buffer.append('stderr', 'err\n');

      const result = buffer.getContent('stderr', 0, 100);
      expect(result.content).toBe('err\n');
      expect(result.stream).toBe('stderr');
    });
  });

  describe('getState', () => {
    it('returns accurate size statistics', () => {
      buffer.append('stdout', '12345\n'); // 6 chars
      buffer.append('stderr', 'abc\n'); // 4 chars

      const state = buffer.getState();
      expect(state.stdoutSize).toBe(6);
      expect(state.stderrSize).toBe(4);
      expect(state.totalSize).toBe(10);
      expect(state.truncated).toBe(false);
    });

    it('includes pending partial lines in size', () => {
      buffer.append('stdout', 'partial');

      const state = buffer.getState();
      expect(state.stdoutSize).toBe(7);
      expect(state.totalSize).toBe(7);
    });
  });

  describe('edge cases', () => {
    it('handles empty appends', () => {
      buffer.append('stdout', '');
      expect(buffer.getState().totalSize).toBe(0);
      expect(buffer.getLines('stdout')).toHaveLength(0);
    });

    it('handles only newlines', () => {
      buffer.append('stdout', '\n\n\n');
      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(3);
      expect(lines.every((l) => l.content === '')).toBe(true);
    });

    it('handles carriage return line endings', () => {
      buffer.append('stdout', 'line1\r\nline2\r\n');
      const lines = buffer.getLines('stdout');
      expect(lines).toHaveLength(2);
      expect(lines[0].content).toBe('line1');
      expect(lines[1].content).toBe('line2');
    });
  });
});
