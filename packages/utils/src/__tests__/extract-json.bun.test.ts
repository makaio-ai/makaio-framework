import { describe, expect, it } from 'bun:test';
import { extractJson } from '../extract-json.js';

describe('extractJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractJson('{"key":"value"}')).toBe('{"key":"value"}');
  });

  it('strips prose surrounding a JSON object', () => {
    const text = 'Here is the result: {"key":"value"} and some trailing text.';
    expect(extractJson(text)).toBe('{"key":"value"}');
  });

  it('strips markdown code fences surrounding a JSON object', () => {
    const text = '```json\n{"key":"value"}\n```';
    expect(extractJson(text)).toBe('{"key":"value"}');
  });

  it('returns original text unchanged when no opening brace is present', () => {
    const text = 'no braces here';
    expect(extractJson(text)).toBe(text);
  });

  it('returns original text unchanged when no closing brace is present', () => {
    const text = '{no closing brace';
    expect(extractJson(text)).toBe(text);
  });

  it('returns original text unchanged when closing brace precedes opening brace', () => {
    const text = '} before {';
    expect(extractJson(text)).toBe(text);
  });

  it('returns the original adjacent brace pair unchanged', () => {
    const text = '{}';
    // firstBrace is 0 and lastBrace is 1, so the extractor returns the full slice.
    expect(extractJson(text)).toBe('{}');
  });

  it('handles nested objects by using the outermost braces', () => {
    const text = '{"outer":{"inner":1}}';
    expect(extractJson(text)).toBe('{"outer":{"inner":1}}');
  });

  it('handles text with multiple JSON-like segments by returning the widest span', () => {
    // firstBrace = position of first '{', lastBrace = position of last '}'
    const text = '{"a":1} some text {"b":2}';
    expect(extractJson(text)).toBe('{"a":1} some text {"b":2}');
  });

  it('returns an empty string input unchanged', () => {
    expect(extractJson('')).toBe('');
  });
});
