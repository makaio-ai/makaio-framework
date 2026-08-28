import { describe, expect, it } from 'vitest';
import { evaluate, type FieldOperator } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an evaluate call for a single top-level field.
 * @param operator - FieldOperator to test
 * @param value - Context value to place at the field key
 * @returns Result of evaluate()
 */
function evalField(operator: FieldOperator, value: unknown): boolean {
  return evaluate({ field: 'x', operator }, { x: value });
}

// ---------------------------------------------------------------------------
// $eq — explicit object form
// ---------------------------------------------------------------------------

describe('$eq operator', () => {
  it('matches a string value', () => {
    expect(evalField({ $eq: 'hello' }, 'hello')).toBe(true);
  });

  it('does not match a different string', () => {
    expect(evalField({ $eq: 'hello' }, 'world')).toBe(false);
  });

  it('matches a number value', () => {
    expect(evalField({ $eq: 42 }, 42)).toBe(true);
  });

  it('does not match a different number', () => {
    expect(evalField({ $eq: 42 }, 43)).toBe(false);
  });

  it('matches boolean true', () => {
    expect(evalField({ $eq: true }, true)).toBe(true);
  });

  it('matches boolean false', () => {
    expect(evalField({ $eq: false }, false)).toBe(true);
  });

  it('does not match true against false', () => {
    expect(evalField({ $eq: true }, false)).toBe(false);
  });

  it('matches null', () => {
    expect(evalField({ $eq: null }, null)).toBe(true);
  });

  it('does not match null against string', () => {
    expect(evalField({ $eq: null }, 'null')).toBe(false);
  });

  it('does not match string "2" against number 2 (strict equality)', () => {
    expect(evalField({ $eq: 2 }, '2')).toBe(false);
  });

  it('does not match undefined — absent field is not equal to null', () => {
    expect(evaluate({ field: 'missing', operator: { $eq: null } }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Implicit equality — bare primitive as operator
// ---------------------------------------------------------------------------

describe('implicit equality (bare primitive operator)', () => {
  it('matches string via bare string operator', () => {
    expect(evalField('active', 'active')).toBe(true);
  });

  it('does not match a different string', () => {
    expect(evalField('active', 'inactive')).toBe(false);
  });

  it('matches number via bare number operator', () => {
    expect(evalField(7, 7)).toBe(true);
  });

  it('does not match number via different number', () => {
    expect(evalField(7, 8)).toBe(false);
  });

  it('matches boolean true via bare operator', () => {
    expect(evalField(true, true)).toBe(true);
  });

  it('matches null via bare null operator', () => {
    expect(evalField(null, null)).toBe(true);
  });

  it('does not match string via number with same apparent value', () => {
    expect(evalField(0, '0')).toBe(false);
  });

  it('does not match undefined field via bare string', () => {
    expect(evaluate({ field: 'missing', operator: 'something' }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $ne operator
// ---------------------------------------------------------------------------

describe('$ne operator', () => {
  it('returns true when value differs', () => {
    expect(evalField({ $ne: 'active' }, 'inactive')).toBe(true);
  });

  it('returns false when value matches', () => {
    expect(evalField({ $ne: 'active' }, 'active')).toBe(false);
  });

  it('returns true for number mismatch', () => {
    expect(evalField({ $ne: 1 }, 2)).toBe(true);
  });

  it('returns false for number match', () => {
    expect(evalField({ $ne: 1 }, 1)).toBe(false);
  });

  it('returns true for null vs string', () => {
    expect(evalField({ $ne: null }, 'text')).toBe(true);
  });

  it('returns false when both are null', () => {
    expect(evalField({ $ne: null }, null)).toBe(false);
  });

  it('returns true for undefined field vs any value (strict inequality)', () => {
    expect(evaluate({ field: 'missing', operator: { $ne: 'x' } }, {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $in operator
// ---------------------------------------------------------------------------

describe('$in operator', () => {
  it('returns true when value is in the array', () => {
    expect(evalField({ $in: ['a', 'b', 'c'] }, 'b')).toBe(true);
  });

  it('returns false when value is not in the array', () => {
    expect(evalField({ $in: ['a', 'b', 'c'] }, 'd')).toBe(false);
  });

  it('returns false for empty array (matches nothing)', () => {
    expect(evalField({ $in: [] }, 'anything')).toBe(false);
  });

  it('matches a number in a numeric array', () => {
    expect(evalField({ $in: [1, 2, 3] }, 2)).toBe(true);
  });

  it('does not match number against string representations', () => {
    expect(evalField({ $in: ['1', '2', '3'] }, 2)).toBe(false);
  });

  it('matches null when null is in the array', () => {
    expect(evalField({ $in: [null, 'other'] }, null)).toBe(true);
  });

  it('does not match undefined against an array of values', () => {
    expect(evaluate({ field: 'missing', operator: { $in: ['a', 'b'] } }, {})).toBe(false);
  });

  it('matches boolean in array', () => {
    expect(evalField({ $in: [true, false] }, false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $nin operator
// ---------------------------------------------------------------------------

describe('$nin operator', () => {
  it('returns false when value is in the array', () => {
    expect(evalField({ $nin: ['a', 'b', 'c'] }, 'b')).toBe(false);
  });

  it('returns true when value is not in the array', () => {
    expect(evalField({ $nin: ['a', 'b', 'c'] }, 'd')).toBe(true);
  });

  it('returns true for empty array (matches everything)', () => {
    expect(evalField({ $nin: [] }, 'anything')).toBe(true);
  });

  it('returns true for undefined field with non-empty array', () => {
    expect(evaluate({ field: 'missing', operator: { $nin: ['a'] } }, {})).toBe(true);
  });

  it('does not exclude null when null is in the array', () => {
    expect(evalField({ $nin: [null] }, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $contains operator
// ---------------------------------------------------------------------------

describe('$contains operator', () => {
  it('returns true when the array contains the value', () => {
    expect(evalField({ $contains: 'b' }, ['a', 'b', 'c'])).toBe(true);
  });

  it('returns false when the array does not contain the value', () => {
    expect(evalField({ $contains: 'd' }, ['a', 'b', 'c'])).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(evalField({ $contains: 'anything' }, [])).toBe(false);
  });

  it('uses strict scalar comparison', () => {
    expect(evalField({ $contains: 2 }, ['1', '2', '3'])).toBe(false);
  });

  it('matches null when the array contains null', () => {
    expect(evalField({ $contains: null }, ['other', null])).toBe(true);
  });

  it('returns false for non-array values', () => {
    expect(evalField({ $contains: 'ell' }, 'hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $containsPrefix operator
// ---------------------------------------------------------------------------

describe('$containsPrefix operator', () => {
  it('returns true when one array element starts with the prefix', () => {
    expect(evalField({ $containsPrefix: 'repo:' }, ['team:core', 'repo:ai-factory'])).toBe(true);
  });

  it('returns false when no array element starts with the prefix', () => {
    expect(evalField({ $containsPrefix: 'repo:' }, ['team:core', 'area:rules'])).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(evalField({ $containsPrefix: 'repo:' }, [])).toBe(false);
  });

  it('returns false for a string value that starts with the prefix', () => {
    expect(evalField({ $containsPrefix: 'repo:' }, 'repo:ai-factory')).toBe(false);
  });

  it('ignores non-string array elements', () => {
    expect(evalField({ $containsPrefix: '1' }, [1, null, true])).toBe(false);
  });

  it('matches any string element for an empty prefix', () => {
    expect(evalField({ $containsPrefix: '' }, ['anything'])).toBe(true);
  });

  it('does not match an empty prefix when no element is a string', () => {
    expect(evalField({ $containsPrefix: '' }, [1, null])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $exists operator
// ---------------------------------------------------------------------------

describe('$exists operator', () => {
  it('returns true for a present string value with $exists: true', () => {
    expect(evalField({ $exists: true }, 'hello')).toBe(true);
  });

  it('returns true for a present number value with $exists: true', () => {
    expect(evalField({ $exists: true }, 0)).toBe(true);
  });

  it('returns true for a present false boolean with $exists: true', () => {
    expect(evalField({ $exists: true }, false)).toBe(true);
  });

  it('returns true for null value with $exists: true (PayloadFilter compatibility)', () => {
    expect(evalField({ $exists: true }, null)).toBe(true);
  });

  it('returns false for undefined (missing field) with $exists: true', () => {
    expect(evaluate({ field: 'missing', operator: { $exists: true } }, {})).toBe(false);
  });

  it('returns false for a present string with $exists: false', () => {
    expect(evalField({ $exists: false }, 'present')).toBe(false);
  });

  it('returns false for null value with $exists: false (null is treated as present)', () => {
    expect(evalField({ $exists: false }, null)).toBe(false);
  });

  it('returns true for undefined (missing field) with $exists: false', () => {
    expect(evaluate({ field: 'missing', operator: { $exists: false } }, {})).toBe(true);
  });

  it('returns false for a nested present value with $exists: false', () => {
    expect(evaluate({ field: 'a.b', operator: { $exists: false } }, { a: { b: 'val' } })).toBe(false);
  });

  it('returns true for a nested missing path with $exists: false', () => {
    expect(evaluate({ field: 'a.b', operator: { $exists: false } }, { a: {} })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $startsWith operator
// ---------------------------------------------------------------------------

describe('$startsWith operator', () => {
  it('returns true when string starts with the prefix', () => {
    expect(evalField({ $startsWith: 'hel' }, 'hello')).toBe(true);
  });

  it('returns false when string does not start with the prefix', () => {
    expect(evalField({ $startsWith: 'world' }, 'hello')).toBe(false);
  });

  it('returns true with empty string prefix (everything starts with empty string)', () => {
    expect(evalField({ $startsWith: '' }, 'anything')).toBe(true);
  });

  it('returns true for exact match (whole string as prefix)', () => {
    expect(evalField({ $startsWith: 'hello' }, 'hello')).toBe(true);
  });

  it('returns false for a non-string value (number)', () => {
    expect(evalField({ $startsWith: '12' }, 1234)).toBe(false);
  });

  it('returns false for a non-string value (boolean)', () => {
    expect(evalField({ $startsWith: 'tr' }, true)).toBe(false);
  });

  it('returns false for null value', () => {
    expect(evalField({ $startsWith: '' }, null)).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(evaluate({ field: 'missing', operator: { $startsWith: 'x' } }, {})).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(evalField({ $startsWith: 'Hello' }, 'hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $endsWith operator
// ---------------------------------------------------------------------------

describe('$endsWith operator', () => {
  it('returns true when string ends with the suffix', () => {
    expect(evalField({ $endsWith: '.ts' }, 'index.ts')).toBe(true);
  });

  it('returns false when string does not end with the suffix', () => {
    expect(evalField({ $endsWith: '.js' }, 'index.ts')).toBe(false);
  });

  it('returns true with empty string suffix', () => {
    expect(evalField({ $endsWith: '' }, 'anything')).toBe(true);
  });

  it('returns true for exact match (whole string as suffix)', () => {
    expect(evalField({ $endsWith: 'hello' }, 'hello')).toBe(true);
  });

  it('returns false for a non-string value (number)', () => {
    expect(evalField({ $endsWith: '34' }, 1234)).toBe(false);
  });

  it('returns false for null value', () => {
    expect(evalField({ $endsWith: '' }, null)).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(evaluate({ field: 'missing', operator: { $endsWith: 'x' } }, {})).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(evalField({ $endsWith: '.TS' }, 'index.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $glob operator
// ---------------------------------------------------------------------------

describe('$glob operator', () => {
  it('matches a simple file extension glob', () => {
    expect(evalField({ $glob: '**/*.ts' }, 'src/index.ts')).toBe(true);
  });

  it('does not match a non-matching extension', () => {
    expect(evalField({ $glob: '**/*.ts' }, 'src/index.js')).toBe(false);
  });

  it('matches a path-prefixed glob', () => {
    expect(evalField({ $glob: 'src/**' }, 'src/utils/helpers.ts')).toBe(true);
  });

  it('does not match a path outside the glob scope', () => {
    expect(evalField({ $glob: 'src/**' }, 'test/utils/helpers.ts')).toBe(false);
  });

  it('matches an exact filename', () => {
    expect(evalField({ $glob: 'README.md' }, 'README.md')).toBe(true);
  });

  it('does not match a different filename with exact pattern', () => {
    expect(evalField({ $glob: 'README.md' }, 'readme.md')).toBe(false);
  });

  it('matches a complex double-star pattern', () => {
    expect(evalField({ $glob: '**/framework/packages/**' }, '/repo/framework/packages/rules/src/index.ts')).toBe(true);
  });

  it('returns false for a non-string value', () => {
    expect(evalField({ $glob: '**/*.ts' }, 42)).toBe(false);
  });

  it('returns false for null value', () => {
    expect(evalField({ $glob: '*' }, null)).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(evaluate({ field: 'missing', operator: { $glob: '*' } }, {})).toBe(false);
  });

  it('matches a single-star pattern at a directory level', () => {
    expect(evalField({ $glob: 'src/*/index.ts' }, 'src/utils/index.ts')).toBe(true);
  });

  it('does not match when single star skips directory separator', () => {
    // Single star does not match path separators by default in minimatch
    expect(evalField({ $glob: 'src/*.ts' }, 'src/utils/index.ts')).toBe(false);
  });

  it('caches the same glob pattern (calling twice is idempotent)', () => {
    const pattern = '**/__tests__/**/*.test.ts';
    expect(evalField({ $glob: pattern }, '__tests__/rules/operators.test.ts')).toBe(true);
    expect(evalField({ $glob: pattern }, '__tests__/rules/operators.test.ts')).toBe(true);
  });
});
