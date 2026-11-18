import { describe, expect, it } from 'vitest';
import { isNonNegativeFinite, nonNegativeOption } from '../non-negative-option.js';

describe('nonNegativeOption', () => {
  it('takes the configured value, zero included, else the fallback', () => {
    expect(nonNegativeOption('windowMs', 250, 10)).toBe(250);
    expect(nonNegativeOption('windowMs', 0, 10)).toBe(0);
    expect(nonNegativeOption('windowMs', undefined, 10)).toBe(10);
  });

  it('refuses a value that is negative, infinite or NaN, naming the option', () => {
    for (const value of [-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => nonNegativeOption('windowMs', value, 10)).toThrow(
        new RangeError('windowMs must be a non-negative finite number'),
      );
    }
  });
});

describe('isNonNegativeFinite', () => {
  it('accepts zero and positive finite numbers only', () => {
    expect([0, 1, 250.5].every(isNonNegativeFinite)).toBe(true);
    expect([-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN].some(isNonNegativeFinite)).toBe(false);
  });
});
