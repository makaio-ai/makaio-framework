import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../deep-freeze.js';

describe('deepFreeze', () => {
  it('returns non-object values unchanged', () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('text')).toBe('text');
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
  });

  it('freezes the value in place and returns the same reference', () => {
    const value = { a: 1 };

    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ nested: { list: [{ leaf: 1 }] } });

    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested.list)).toBe(true);
    expect(Object.isFrozen(value.nested.list[0])).toBe(true);
  });

  it('descends into an already shallowly frozen container', () => {
    // `Object.freeze` is shallow, so a frozen outer object can still hold a
    // mutable child. Short-circuiting on the outer object would leave it mutable.
    const child = { leaf: 1 };
    const value = Object.freeze({ child });

    deepFreeze(value);

    expect(Object.isFrozen(child)).toBe(true);
  });
});
