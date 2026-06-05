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

  it('uses the first text content entry from structured output', () => {
    expect(normalizeToolOutput([{ type: 'text', text: 'file written' }])).toBe('file written');
  });

  it('stringifies JSON-compatible structured output', () => {
    expect(normalizeToolOutput({ ok: true })).toBe('{"ok":true}');
  });

  it('falls back to String() for non-JSON output', () => {
    expect(normalizeToolOutput(1n)).toBe('1');

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(normalizeToolOutput(circular)).toBe('[object Object]');
  });
});
