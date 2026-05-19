import { describe, expect, it } from 'bun:test';
import { safeStringify } from '../safe-stringify.js';

describe('safeStringify', () => {
  it('returns JSON strings for unsupported top-level values', () => {
    expect(JSON.parse(safeStringify(Symbol('token')))).toBe('Symbol(token)');
    expect(typeof JSON.parse(safeStringify(() => undefined))).toBe('string');
  });

  it('serializes bigint values deterministically', () => {
    expect(JSON.parse(safeStringify(123n))).toBe('123');
    expect(JSON.parse(safeStringify({ n: 7n }))).toEqual({ n: '7' });
  });

  it('handles circular values without throwing', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(JSON.parse(safeStringify(value))).toEqual({ self: '[Circular]' });
  });

  it('does not mark repeated shared references as circular', () => {
    const shared = { id: 1 };
    const value = { first: shared, second: shared };

    expect(JSON.parse(safeStringify(value))).toEqual({
      first: { id: 1 },
      second: { id: 1 },
    });
  });
});
