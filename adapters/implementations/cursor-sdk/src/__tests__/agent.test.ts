import { describe, expect, it } from 'vitest';
import { normalizeCursorUsage, normalizeToolOutput, type CursorRawUsage } from '../agent.js';

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

describe('normalizeCursorUsage', () => {
  const rawUsage: CursorRawUsage = {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
  };

  it('declares turn-aggregate granularity on the emitted usage payload', () => {
    expect(normalizeCursorUsage(rawUsage).granularity).toBe('turn-aggregate');
  });

  it('computes totalTokens when the SDK omits it', () => {
    const result = normalizeCursorUsage(rawUsage);

    expect(result.totalTokens).toBe(140);
    expect(result.costUnits).toBe(140);
    expect(result.costUnitType).toBe('tokens');
  });

  it('omits cost when the SDK does not report an amount', () => {
    expect(normalizeCursorUsage(rawUsage)).not.toHaveProperty('cost');
  });

  it('forwards the SDK-reported cost verbatim', () => {
    expect(normalizeCursorUsage({ ...rawUsage, cost: 0.42 }).cost).toBe(0.42);
  });
});
