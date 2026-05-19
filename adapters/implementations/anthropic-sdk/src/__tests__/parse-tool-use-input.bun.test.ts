import { describe, expect, it } from 'bun:test';
import { parseToolUseInput } from '../utils/parse-tool-use-input.js';

describe('parseToolUseInput', () => {
  it('returns parsed object for valid JSON object input', () => {
    expect(parseToolUseInput('{"path":"/tmp/a","count":2}')).toEqual({
      path: '/tmp/a',
      count: 2,
    });
  });

  it('returns parse marker object for non-object JSON', () => {
    expect(parseToolUseInput('"text"')).toEqual({ raw: '"text"', parseError: true });
    expect(parseToolUseInput('123')).toEqual({ raw: '123', parseError: true });
    expect(parseToolUseInput('[1,2,3]')).toEqual({ raw: '[1,2,3]', parseError: true });
    expect(parseToolUseInput('null')).toEqual({ raw: 'null', parseError: true });
  });

  it('returns parse marker object for malformed JSON', () => {
    expect(parseToolUseInput('{"path":')).toEqual({ raw: '{"path":', parseError: true });
  });
});
