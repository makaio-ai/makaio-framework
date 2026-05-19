import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseJsonlFile, someJsonlRecord } from '@makaio/ai-adapters-core/node';

interface TestRecord {
  type: string;
  data?: unknown;
  id?: number;
}

describe('parseJsonlFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-test-'));
  });

  describe('someJsonlRecord', () => {
    it('short-circuits once a matching record is found', async () => {
      const content = ['{"type":"system"}', '{"type":"message","data":"hello"}', '{"type":"message","data":"later"}']
        .join('\n')
        .concat('\n');

      const filePath = await createTestFile('some.jsonl', content);
      const seenTypes: string[] = [];

      const matched = await someJsonlRecord<TestRecord>(filePath, (record) => {
        seenTypes.push(record.type);
        return record.type === 'message';
      });

      expect(matched).toBe(true);
      expect(seenTypes).toEqual(['system', 'message']);
    });

    it('returns false when no record matches', async () => {
      const content = ['{"type":"system"}', '{"type":"status"}'].join('\n') + '\n';
      const filePath = await createTestFile('some-miss.jsonl', content);

      await expect(someJsonlRecord<TestRecord>(filePath, (record) => record.type === 'message')).resolves.toBe(false);
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a test file with the given content.
   * @param filename - Name of the file to create
   * @param content - Content to write to the file
   */
  async function createTestFile(filename: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  describe('basic parsing', () => {
    it('should parse a valid JSONL file with multiple records', async () => {
      const content =
        ['{"type":"message","data":"hello"}', '{"type":"event","data":123}', '{"type":"status","data":true}'].join(
          '\n',
        ) + '\n';

      const filePath = await createTestFile('basic.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(3);
      expect(result.records[0]).toEqual({ type: 'message', data: 'hello' });
      expect(result.records[1]).toEqual({ type: 'event', data: 123 });
      expect(result.records[2]).toEqual({ type: 'status', data: true });
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('should parse a single record file', async () => {
      const content = '{"type":"single"}\n';
      const filePath = await createTestFile('single.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toEqual({ type: 'single' });
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('should return empty result for empty file', async () => {
      const filePath = await createTestFile('empty.jsonl', '');
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(0);
    });

    it('should skip empty lines', async () => {
      const content = '{"type":"first"}\n\n{"type":"second"}\n\n';
      const filePath = await createTestFile('empty-lines.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toEqual({ type: 'first' });
      expect(result.records[1]).toEqual({ type: 'second' });
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });
  });

  describe('partial line handling', () => {
    it('should not process incomplete trailing line (no newline)', async () => {
      // Simulates a file being actively written to
      const content = '{"type":"complete"}\n{"type":"incomplete"';
      const filePath = await createTestFile('partial.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toEqual({ type: 'complete' });
      expect(result.errors).toHaveLength(0);
      // bytesRead should be at end of complete line (after first \n)
      expect(result.bytesRead).toBe(Buffer.byteLength('{"type":"complete"}\n', 'utf8'));
    });

    it('should return zero bytesRead if only incomplete content exists', async () => {
      const content = '{"type":"incomplete"';
      const filePath = await createTestFile('only-partial.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(0);
    });

    it('should handle file with only whitespace and no valid records', async () => {
      const content = '   \n\n  \n';
      const filePath = await createTestFile('whitespace.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      // All empty/whitespace lines are processed
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });
  });

  describe('error handling', () => {
    it('should skip malformed JSON and continue parsing', async () => {
      const content = ['{"type":"valid1"}', 'not valid json', '{"type":"valid2"}'].join('\n') + '\n';

      const filePath = await createTestFile('malformed.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toEqual({ type: 'valid1' });
      expect(result.records[1]).toEqual({ type: 'valid2' });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].line).toBe(2);
      expect(result.errors[0].content).toBe('not valid json');
      // Bun: "JSON Parse error: Unexpected identifier \"not\""
      // Node/V8: "Unexpected token 'n', ..."
      expect(result.errors[0].error.length).toBeGreaterThan(0);
    });

    it('should track multiple errors without stopping', async () => {
      const content = ['{"type":"valid"}', '{broken', 'also broken', '{"type":"still valid"}'].join('\n') + '\n';

      const filePath = await createTestFile('multi-error.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].line).toBe(2);
      expect(result.errors[1].line).toBe(3);
    });

    it('should truncate long content in error messages', async () => {
      const longData = 'a'.repeat(300);
      const content = `{invalid: ${longData}}\n`;
      const filePath = await createTestFile('long-error.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].content.length).toBeLessThanOrEqual(203); // 200 + "..."
      expect(result.errors[0].content).toContain('...');
    });

    it('should throw error for non-existent file', async () => {
      const filePath = path.join(tempDir, 'nonexistent.jsonl');

      await expect(parseJsonlFile<TestRecord>({ filePath })).rejects.toThrow();
    });
  });

  describe('offset reading', () => {
    it('should read from specified byte offset', async () => {
      const firstLine = '{"type":"first","id":1}\n';
      const secondLine = '{"type":"second","id":2}\n';
      const content = firstLine + secondLine;

      const filePath = await createTestFile('offset.jsonl', content);
      const offset = Buffer.byteLength(firstLine, 'utf8');

      const result = await parseJsonlFile<TestRecord>({ filePath, startOffset: offset });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toEqual({ type: 'second', id: 2 });
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('should return empty result if offset is at end of file', async () => {
      const content = '{"type":"only"}\n';
      const filePath = await createTestFile('at-end.jsonl', content);
      const fileSize = Buffer.byteLength(content, 'utf8');

      const result = await parseJsonlFile<TestRecord>({ filePath, startOffset: fileSize });

      expect(result.records).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(fileSize);
    });

    it('should return empty result if offset is past end of file', async () => {
      const content = '{"type":"only"}\n';
      const filePath = await createTestFile('past-end.jsonl', content);
      const fileSize = Buffer.byteLength(content, 'utf8');

      const result = await parseJsonlFile<TestRecord>({ filePath, startOffset: fileSize + 100 });

      expect(result.records).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(fileSize + 100);
    });

    it('should correctly report line numbers when starting from offset', async () => {
      const lines = ['{"type":"line1"}', '{"type":"line2"}', 'invalid line 3', '{"type":"line4"}'].join('\n') + '\n';

      const filePath = await createTestFile('line-numbers.jsonl', lines);
      const firstLineOffset = Buffer.byteLength('{"type":"line1"}\n', 'utf8');

      const result = await parseJsonlFile<TestRecord>({ filePath, startOffset: firstLineOffset });

      expect(result.records).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      // Error should report absolute line number (3), not relative (2)
      expect(result.errors[0].line).toBe(3);
    });
  });

  describe('resumable reading simulation', () => {
    it('should allow incremental reading with cursor', async () => {
      // Simulate a file that grows over time
      const content1 = '{"type":"batch1","id":1}\n';
      const content2 = '{"type":"batch2","id":2}\n';
      const content3 = '{"type":"batch3","id":3}\n';

      const filePath = await createTestFile('incremental.jsonl', content1);

      // First read
      const result1 = await parseJsonlFile<TestRecord>({ filePath });
      expect(result1.records).toHaveLength(1);
      expect(result1.records[0].id).toBe(1);

      // Simulate file growth (append more content)
      await fs.appendFile(filePath, content2);

      // Second read using cursor from first read
      const result2 = await parseJsonlFile<TestRecord>({ filePath, startOffset: result1.bytesRead });
      expect(result2.records).toHaveLength(1);
      expect(result2.records[0].id).toBe(2);

      // Simulate more growth
      await fs.appendFile(filePath, content3);

      // Third read using cursor from second read
      const result3 = await parseJsonlFile<TestRecord>({ filePath, startOffset: result2.bytesRead });
      expect(result3.records).toHaveLength(1);
      expect(result3.records[0].id).toBe(3);
    });

    it('should handle partial line completion across reads', async () => {
      // Simulate file being written to mid-line
      const filePath = path.join(tempDir, 'growing.jsonl');
      const complete = '{"type":"complete"}\n';
      const partial = '{"type":"incompleteee'; // No newline

      // Write complete line + partial line
      await fs.writeFile(filePath, complete + partial, 'utf8');

      // First read - should only get complete line
      const result1 = await parseJsonlFile<TestRecord>({ filePath });
      expect(result1.records).toHaveLength(1);
      expect(result1.records[0].type).toBe('complete');

      // Simulate line completion
      const remaining = '"}\n';
      await fs.appendFile(filePath, remaining, 'utf8');

      // Second read from cursor - should get the now-complete line
      const result2 = await parseJsonlFile<TestRecord>({ filePath, startOffset: result1.bytesRead });
      expect(result2.records).toHaveLength(1);
      expect(result2.records[0].type).toBe('incompleteee');
    });
  });

  describe('unicode and special characters', () => {
    it('should correctly handle unicode characters', async () => {
      const content = '{"type":"message","data":"Hello, World!"}\n';
      const filePath = await createTestFile('unicode.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].data).toBe('Hello, World!');
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });

    it('should handle multi-byte characters correctly with offset', async () => {
      const line1 = '{"type":"first"}\n';
      const line2 = '{"type":"second"}\n';
      const content = line1 + line2;
      const filePath = await createTestFile('multibyte-offset.jsonl', content);

      // Read from offset using byte length (not string length)
      const offset = Buffer.byteLength(line1, 'utf8');
      const result = await parseJsonlFile<TestRecord>({ filePath, startOffset: offset });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].type).toBe('second');
    });

    it('should handle escaped characters in JSON', async () => {
      const content = '{"type":"message","data":"line1\\nline2\\ttab"}\n';
      const filePath = await createTestFile('escaped.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].data).toBe('line1\nline2\ttab');
    });
  });

  describe('large file handling', () => {
    it('should handle files larger than the internal buffer', async () => {
      // Create a file larger than the 64KB buffer
      const records: TestRecord[] = [];
      const lines: string[] = [];

      for (let i = 0; i < 2000; i++) {
        const record = { type: 'record', id: i, data: `data-${i}` };
        records.push(record);
        lines.push(JSON.stringify(record));
      }

      const content = lines.join('\n') + '\n';
      const filePath = await createTestFile('large.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(2000);
      expect(result.records[0].id).toBe(0);
      expect(result.records[1999].id).toBe(1999);
      expect(result.errors).toHaveLength(0);
      expect(result.bytesRead).toBe(Buffer.byteLength(content, 'utf8'));
    });
  });

  describe('edge cases', () => {
    it('should handle records with nested objects', async () => {
      const content = '{"type":"nested","data":{"inner":{"deep":[1,2,3]}}}\n';
      const filePath = await createTestFile('nested.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      expect(result.records).toHaveLength(1);
      expect(result.records[0]).toEqual({
        type: 'nested',
        data: { inner: { deep: [1, 2, 3] } },
      });
    });

    it('should handle array JSON values', async () => {
      const content = '[1,2,3]\n["a","b","c"]\n';
      const filePath = await createTestFile('arrays.jsonl', content);
      const result = await parseJsonlFile<number[] | string[]>({ filePath });

      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toEqual([1, 2, 3]);
      expect(result.records[1]).toEqual(['a', 'b', 'c']);
    });

    it('should handle primitive JSON values', async () => {
      const content = '"string"\n123\ntrue\nnull\n';
      const filePath = await createTestFile('primitives.jsonl', content);
      const result = await parseJsonlFile<string | number | boolean | null>({ filePath });

      expect(result.records).toHaveLength(4);
      expect(result.records[0]).toBe('string');
      expect(result.records[1]).toBe(123);
      expect(result.records[2]).toBe(true);
      expect(result.records[3]).toBeNull();
    });

    it('should handle Windows line endings (CRLF)', async () => {
      const content = '{"type":"first"}\r\n{"type":"second"}\r\n';
      const filePath = await createTestFile('crlf.jsonl', content);
      const result = await parseJsonlFile<TestRecord>({ filePath });

      // Note: CRLF will leave \r in the content, which should be handled by JSON.parse
      // Standard JSONL uses LF only, but we should be lenient
      expect(result.records).toHaveLength(2);
      // The \r before the newline becomes part of the line content
      // JSON.parse should still work as whitespace around JSON is ignored
      expect(result.records.map((r) => r.type)).toEqual(['first', 'second']);
    });

    it('should correctly count bytes with mixed content', async () => {
      const lines = [
        '{"id":1}', // 8 chars
        '{"id":2}', // 8 chars
        '{"id":3}', // 8 chars
      ];
      const content = lines.join('\n') + '\n'; // 8 + 1 + 8 + 1 + 8 + 1 = 27 bytes
      const filePath = await createTestFile('byte-count.jsonl', content);
      const result = await parseJsonlFile<{ id: number }>({ filePath });

      expect(result.records).toHaveLength(3);
      expect(result.bytesRead).toBe(27);
    });
  });
});
