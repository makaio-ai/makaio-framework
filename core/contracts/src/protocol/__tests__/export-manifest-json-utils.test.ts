import { describe, expect, it } from 'vitest';
import { sortJsonValue } from '../export-manifest-json-utils.js';

describe('sortJsonValue', () => {
  it('sorts nested object keys recursively', () => {
    const input = { z: { b: 1, a: 2 }, a: 3 };
    const result = sortJsonValue(input);
    expect(Object.keys(result as object)).toEqual(['a', 'z']);
    expect(Object.keys((result as Record<string, unknown>).z as object)).toEqual(['a', 'b']);
  });

  it('preserves array order while sorting object entries within arrays', () => {
    const input = [
      { b: 2, a: 1 },
      { d: 4, c: 3 },
    ];
    const result = sortJsonValue(input) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0])).toEqual(['a', 'b']);
    expect(Object.keys(result[1])).toEqual(['c', 'd']);
    expect(result[0]).toEqual({ a: 1, b: 2 });
    expect(result[1]).toEqual({ c: 3, d: 4 });
  });

  it('passes primitives and null through unchanged', () => {
    expect(sortJsonValue(null)).toBeNull();
    expect(sortJsonValue(42)).toBe(42);
    expect(sortJsonValue('hello')).toBe('hello');
    expect(sortJsonValue(true)).toBe(true);
  });

  it('orders mixed-case keys by compareStrings (case-folded primary, code-point tie-break)', () => {
    // Default sort() would give ['B', 'a', 'c'] (uppercase ASCII before lowercase).
    // compareStrings folds first: 'a'→'a' < 'B'→'b' < 'c'→'c', so result is ['a', 'B', 'c'].
    const input = { B: 1, c: 2, a: 3 };
    const result = sortJsonValue(input);
    expect(Object.keys(result as object)).toEqual(['a', 'B', 'c']);
  });
});
