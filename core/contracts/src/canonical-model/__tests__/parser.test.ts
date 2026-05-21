import { describe, expect, it } from 'vitest';
import { isCanonicalModelParseError, parseCanonicalModel } from '../parser.js';

describe('parseCanonicalModel', () => {
  it('parses bare model references', () => {
    expect(parseCanonicalModel('sonnet')).toEqual({ kind: 'bare', model: 'sonnet' });
  });

  it('parses qualified model references', () => {
    expect(parseCanonicalModel('OpenAI-Node/OpenRouter::gpt-4o')).toEqual({
      kind: 'qualified',
      segment1: 'openai-node',
      segment2: 'openrouter',
      model: 'gpt-4o',
    });
  });

  it('parses host-owned virtual references without resolving them', () => {
    expect(parseCanonicalModel('~best-coder')).toEqual({ kind: 'virtual', name: 'best-coder' });
  });

  it('returns a parse error for invalid virtual names', () => {
    const result = parseCanonicalModel('~Bad Name');

    expect(isCanonicalModelParseError(result)).toBe(true);
    expect(result).toMatchObject({ kind: 'parse-error', code: 'invalid-virtual-name' });
  });
});
