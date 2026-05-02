import { describe, expect, it } from 'vitest';
import { normalizeToolOutput } from '../agent.js';

describe('normalizeToolOutput', () => {
  it('returns an empty string for nullish output', () => {
    expect(normalizeToolOutput(null)).toBe('');
    expect(normalizeToolOutput(undefined)).toBe('');
  });

  it('returns string output unchanged', () => {
    expect(normalizeToolOutput('done')).toBe('done');
  });

  it('stringifies structured output', () => {
    expect(normalizeToolOutput({ ok: true })).toBe('{"ok":true}');
  });
});
