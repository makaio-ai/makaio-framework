import { describe, expect, it } from 'vitest';
import { canonicalStringify } from '../canonical-stringify.js';

describe('canonicalStringify', () => {
  it('serializes scalars like JSON.stringify', () => {
    expect(canonicalStringify('text')).toBe('"text"');
    expect(canonicalStringify(42)).toBe('42');
    expect(canonicalStringify(true)).toBe('true');
    expect(canonicalStringify(null)).toBe('null');
  });

  it('produces identical output for objects with different key insertion order', () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
    expect(canonicalStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it('sorts keys recursively in nested objects', () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };

    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(canonicalStringify(left)).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('preserves array element order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalStringify([3, 1, 2])).not.toBe(canonicalStringify([1, 2, 3]));
  });

  it('sorts keys of objects nested inside arrays', () => {
    expect(canonicalStringify([{ b: 2, a: 1 }])).toBe('[{"a":1,"b":2}]');
  });

  it('distinguishes values that differ beyond key order', () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 1, b: 2 }));
  });

  it('drops undefined object values like JSON.stringify', () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('rejects top-level values that JSON.stringify cannot serialize', () => {
    for (const value of [undefined, () => undefined, Symbol('value')]) {
      expect(() => canonicalStringify(value)).toThrow(
        'canonicalStringify requires a top-level JSON-serializable value',
      );
    }
  });

  it('preserves __proto__ as a sorted JSON key', () => {
    const first = JSON.parse('{"z":1,"__proto__":{"value":"first"}}');
    const second = JSON.parse('{"z":1,"__proto__":{"value":"second"}}');

    const firstCanonical = canonicalStringify(first);
    const secondCanonical = canonicalStringify(second);

    expect(firstCanonical).toBe('{"__proto__":{"value":"first"},"z":1}');
    expect(firstCanonical).not.toBe(secondCanonical);
    expect(JSON.parse(firstCanonical)).toEqual(first);
  });
});
