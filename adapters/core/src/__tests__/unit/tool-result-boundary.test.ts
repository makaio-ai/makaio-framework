import { describe, expect, it } from 'vitest';
import { boundToolResultContent, MAX_TOOL_RESULT_CONTENT_CHARS } from '@makaio/ai-adapters-stream-session';
const TRUNCATION_SUFFIX_PATTERN = /\n\.\.\.\[truncated (\d+) chars\]$/;

describe('boundToolResultContent', () => {
  it('returns content unchanged when at or under limit', () => {
    const atLimit = 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS);
    const underLimit = 'x'.repeat(MAX_TOOL_RESULT_CONTENT_CHARS - 1);

    expect(boundToolResultContent(atLimit)).toBe(atLimit);
    expect(boundToolResultContent(underLimit)).toBe(underLimit);
  });

  it('bounds output and reports omitted char count consistently near boundary sizes', () => {
    for (const contentLength of [8_001, 8_009, 8_010, 8_099, 8_100, 12_345]) {
      const content = 'x'.repeat(contentLength);
      const result = boundToolResultContent(content);

      expect(result.length).toBe(MAX_TOOL_RESULT_CONTENT_CHARS);
      const suffixMatch = result.match(TRUNCATION_SUFFIX_PATTERN);
      expect(suffixMatch).not.toBeNull();

      const suffix = suffixMatch![0];
      const omittedChars = Number(suffixMatch![1]);
      const keptChars = result.length - suffix.length;

      expect(keptChars).toBeGreaterThan(0);
      expect(omittedChars).toBe(contentLength - keptChars);
    }
  });
});
