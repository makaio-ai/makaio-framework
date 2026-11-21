import { describe, expect, it } from 'vitest';
import { fieldMatches, matched } from './support.js';

// ---------------------------------------------------------------------------
// $eq — explicit object form
// ---------------------------------------------------------------------------

describe('$eq operator', () => {
  it('matches a string value', () => {
    expect(fieldMatches({ $eq: 'hello' }, { x: 'hello' })).toBe(true);
  });

  it('does not match a different string', () => {
    expect(fieldMatches({ $eq: 'hello' }, { x: 'world' })).toBe(false);
  });

  it('matches a number value', () => {
    expect(fieldMatches({ $eq: 42 }, { x: 42 })).toBe(true);
  });

  it('does not match a different number', () => {
    expect(fieldMatches({ $eq: 42 }, { x: 43 })).toBe(false);
  });

  it('matches boolean true', () => {
    expect(fieldMatches({ $eq: true }, { x: true })).toBe(true);
  });

  it('matches boolean false', () => {
    expect(fieldMatches({ $eq: false }, { x: false })).toBe(true);
  });

  it('does not match true against false', () => {
    expect(fieldMatches({ $eq: true }, { x: false })).toBe(false);
  });

  it('matches null', () => {
    expect(fieldMatches({ $eq: null }, { x: null })).toBe(true);
  });

  it('does not match null against string', () => {
    expect(fieldMatches({ $eq: null }, { x: 'null' })).toBe(false);
  });

  it('does not match string "2" against number 2 (strict equality)', () => {
    expect(fieldMatches({ $eq: 2 }, { x: '2' })).toBe(false);
  });

  it('does not match undefined — absent field is not equal to null', () => {
    expect(matched({ field: 'missing', operator: { $eq: null } }, {})).toBe(false);
  });
});

describe('$eq operator with objects and lists', () => {
  it('matches an object with the same keys in a different order', () => {
    expect(fieldMatches({ $eq: { a: 1, b: 'x' } }, { x: { b: 'x', a: 1 } })).toBe(true);
  });

  it('does not match an object with a different value', () => {
    expect(fieldMatches({ $eq: { a: 1, b: 'x' } }, { x: { b: 'y', a: 1 } })).toBe(false);
  });

  it('matches a list with the same elements in the same order', () => {
    expect(fieldMatches({ $eq: [1, 'two', { k: 3, j: 4 }] }, { x: [1, 'two', { j: 4, k: 3 }] })).toBe(true);
  });

  it('does not match a list with the same elements in a different order', () => {
    expect(fieldMatches({ $eq: [1, 2] }, { x: [2, 1] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Implicit equality — bare primitive as operator
// ---------------------------------------------------------------------------

describe('implicit equality (bare primitive operator)', () => {
  it('matches string via bare string operator', () => {
    expect(fieldMatches('active', { x: 'active' })).toBe(true);
  });

  it('does not match a different string', () => {
    expect(fieldMatches('active', { x: 'inactive' })).toBe(false);
  });

  it('matches number via bare number operator', () => {
    expect(fieldMatches(7, { x: 7 })).toBe(true);
  });

  it('does not match number via different number', () => {
    expect(fieldMatches(7, { x: 8 })).toBe(false);
  });

  it('matches boolean true via bare operator', () => {
    expect(fieldMatches(true, { x: true })).toBe(true);
  });

  it('matches null via bare null operator', () => {
    expect(fieldMatches(null, { x: null })).toBe(true);
  });

  it('does not match string via number with same apparent value', () => {
    expect(fieldMatches(0, { x: '0' })).toBe(false);
  });

  it('does not match undefined field via bare string', () => {
    expect(matched({ field: 'missing', operator: 'something' }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $ne operator
// ---------------------------------------------------------------------------

describe('$ne operator', () => {
  it('returns true when value differs', () => {
    expect(fieldMatches({ $ne: 'active' }, { x: 'inactive' })).toBe(true);
  });

  it('returns false when value matches', () => {
    expect(fieldMatches({ $ne: 'active' }, { x: 'active' })).toBe(false);
  });

  it('returns true for number mismatch', () => {
    expect(fieldMatches({ $ne: 1 }, { x: 2 })).toBe(true);
  });

  it('returns false for number match', () => {
    expect(fieldMatches({ $ne: 1 }, { x: 1 })).toBe(false);
  });

  it('returns true for null vs string', () => {
    expect(fieldMatches({ $ne: null }, { x: 'text' })).toBe(true);
  });

  it('returns false when both are null', () => {
    expect(fieldMatches({ $ne: null }, { x: null })).toBe(false);
  });

  it('returns true for undefined field vs any value (strict inequality)', () => {
    expect(matched({ field: 'missing', operator: { $ne: 'x' } }, {})).toBe(true);
  });
});

describe('$ne operator with objects and lists', () => {
  it('returns false for an object with the same keys in a different order', () => {
    expect(fieldMatches({ $ne: { a: 1, b: 'x' } }, { x: { b: 'x', a: 1 } })).toBe(false);
  });

  it('returns true for an object with a different value', () => {
    expect(fieldMatches({ $ne: { a: 1, b: 'x' } }, { x: { a: 1, b: 'y' } })).toBe(true);
  });

  it('returns false for a list with the same elements, including a reordered nested object', () => {
    expect(fieldMatches({ $ne: [{ k: 1, j: 2 }, 'z'] }, { x: [{ j: 2, k: 1 }, 'z'] })).toBe(false);
  });

  it('returns true for a list with the same elements in a different order', () => {
    expect(fieldMatches({ $ne: ['a', 'b'] }, { x: ['b', 'a'] })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $in operator
// ---------------------------------------------------------------------------

describe('$in operator', () => {
  it('returns true when value is in the array', () => {
    expect(fieldMatches({ $in: ['a', 'b', 'c'] }, { x: 'b' })).toBe(true);
  });

  it('returns false when value is not in the array', () => {
    expect(fieldMatches({ $in: ['a', 'b', 'c'] }, { x: 'd' })).toBe(false);
  });

  it('returns false for empty array (matches nothing)', () => {
    expect(fieldMatches({ $in: [] }, { x: 'anything' })).toBe(false);
  });

  it('matches a number in a numeric array', () => {
    expect(fieldMatches({ $in: [1, 2, 3] }, { x: 2 })).toBe(true);
  });

  it('does not match number against string representations', () => {
    expect(fieldMatches({ $in: ['1', '2', '3'] }, { x: 2 })).toBe(false);
  });

  it('matches null when null is in the array', () => {
    expect(fieldMatches({ $in: [null, 'other'] }, { x: null })).toBe(true);
  });

  it('does not match undefined against an array of values', () => {
    expect(matched({ field: 'missing', operator: { $in: ['a', 'b'] } }, {})).toBe(false);
  });

  it('matches boolean in array', () => {
    expect(fieldMatches({ $in: [true, false] }, { x: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $nin operator
// ---------------------------------------------------------------------------

describe('$nin operator', () => {
  it('returns false when value is in the array', () => {
    expect(fieldMatches({ $nin: ['a', 'b', 'c'] }, { x: 'b' })).toBe(false);
  });

  it('returns true when value is not in the array', () => {
    expect(fieldMatches({ $nin: ['a', 'b', 'c'] }, { x: 'd' })).toBe(true);
  });

  it('returns true for empty array (matches everything)', () => {
    expect(fieldMatches({ $nin: [] }, { x: 'anything' })).toBe(true);
  });

  it('returns true for undefined field with non-empty array', () => {
    expect(matched({ field: 'missing', operator: { $nin: ['a'] } }, {})).toBe(true);
  });

  it('does not exclude null when null is in the array', () => {
    expect(fieldMatches({ $nin: [null] }, { x: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $contains operator
// ---------------------------------------------------------------------------

describe('$contains operator', () => {
  it('returns true when the array contains the value', () => {
    expect(fieldMatches({ $contains: 'b' }, { x: ['a', 'b', 'c'] })).toBe(true);
  });

  it('returns false when the array does not contain the value', () => {
    expect(fieldMatches({ $contains: 'd' }, { x: ['a', 'b', 'c'] })).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(fieldMatches({ $contains: 'anything' }, { x: [] })).toBe(false);
  });

  it('uses strict scalar comparison', () => {
    expect(fieldMatches({ $contains: 2 }, { x: ['1', '2', '3'] })).toBe(false);
  });

  it('matches null when the array contains null', () => {
    expect(fieldMatches({ $contains: null }, { x: ['other', null] })).toBe(true);
  });

  it('returns false for non-array values', () => {
    expect(fieldMatches({ $contains: 'ell' }, { x: 'hello' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $containsPrefix operator
// ---------------------------------------------------------------------------

describe('$containsPrefix operator', () => {
  it('returns true when one array element starts with the prefix', () => {
    expect(fieldMatches({ $containsPrefix: 'repo:' }, { x: ['team:core', 'repo:ai-factory'] })).toBe(true);
  });

  it('returns false when no array element starts with the prefix', () => {
    expect(fieldMatches({ $containsPrefix: 'repo:' }, { x: ['team:core', 'area:rules'] })).toBe(false);
  });

  it('returns false for an empty array', () => {
    expect(fieldMatches({ $containsPrefix: 'repo:' }, { x: [] })).toBe(false);
  });

  it('returns false for a string value that starts with the prefix', () => {
    expect(fieldMatches({ $containsPrefix: 'repo:' }, { x: 'repo:ai-factory' })).toBe(false);
  });

  it('ignores non-string array elements', () => {
    expect(fieldMatches({ $containsPrefix: '1' }, { x: [1, null, true] })).toBe(false);
  });

  it('matches any string element for an empty prefix', () => {
    expect(fieldMatches({ $containsPrefix: '' }, { x: ['anything'] })).toBe(true);
  });

  it('does not match an empty prefix when no element is a string', () => {
    expect(fieldMatches({ $containsPrefix: '' }, { x: [1, null] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $exists operator
// ---------------------------------------------------------------------------

describe('$exists operator', () => {
  it('returns true for a present string value with $exists: true', () => {
    expect(fieldMatches({ $exists: true }, { x: 'hello' })).toBe(true);
  });

  it('returns true for a present number value with $exists: true', () => {
    expect(fieldMatches({ $exists: true }, { x: 0 })).toBe(true);
  });

  it('returns true for a present false boolean with $exists: true', () => {
    expect(fieldMatches({ $exists: true }, { x: false })).toBe(true);
  });

  it('returns true for null value with $exists: true (PayloadFilter compatibility)', () => {
    expect(fieldMatches({ $exists: true }, { x: null })).toBe(true);
  });

  it('returns false for undefined (missing field) with $exists: true', () => {
    expect(matched({ field: 'missing', operator: { $exists: true } }, {})).toBe(false);
  });

  it('returns false for a present string with $exists: false', () => {
    expect(fieldMatches({ $exists: false }, { x: 'present' })).toBe(false);
  });

  it('returns false for null value with $exists: false (null is treated as present)', () => {
    expect(fieldMatches({ $exists: false }, { x: null })).toBe(false);
  });

  it('returns true for undefined (missing field) with $exists: false', () => {
    expect(matched({ field: 'missing', operator: { $exists: false } }, {})).toBe(true);
  });

  it('returns false for a nested present value with $exists: false', () => {
    expect(matched({ field: 'a.b', operator: { $exists: false } }, { a: { b: 'val' } })).toBe(false);
  });

  it('returns true for a nested missing path with $exists: false', () => {
    expect(matched({ field: 'a.b', operator: { $exists: false } }, { a: {} })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// $startsWith operator
// ---------------------------------------------------------------------------

describe('$startsWith operator', () => {
  it('returns true when string starts with the prefix', () => {
    expect(fieldMatches({ $startsWith: 'hel' }, { x: 'hello' })).toBe(true);
  });

  it('returns false when string does not start with the prefix', () => {
    expect(fieldMatches({ $startsWith: 'world' }, { x: 'hello' })).toBe(false);
  });

  it('returns true with empty string prefix (everything starts with empty string)', () => {
    expect(fieldMatches({ $startsWith: '' }, { x: 'anything' })).toBe(true);
  });

  it('returns true for exact match (whole string as prefix)', () => {
    expect(fieldMatches({ $startsWith: 'hello' }, { x: 'hello' })).toBe(true);
  });

  it('returns false for a non-string value (number)', () => {
    expect(fieldMatches({ $startsWith: '12' }, { x: 1234 })).toBe(false);
  });

  it('returns false for a non-string value (boolean)', () => {
    expect(fieldMatches({ $startsWith: 'tr' }, { x: true })).toBe(false);
  });

  it('returns false for null value', () => {
    expect(fieldMatches({ $startsWith: '' }, { x: null })).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(matched({ field: 'missing', operator: { $startsWith: 'x' } }, {})).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(fieldMatches({ $startsWith: 'Hello' }, { x: 'hello' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $endsWith operator
// ---------------------------------------------------------------------------

describe('$endsWith operator', () => {
  it('returns true when string ends with the suffix', () => {
    expect(fieldMatches({ $endsWith: '.ts' }, { x: 'index.ts' })).toBe(true);
  });

  it('returns false when string does not end with the suffix', () => {
    expect(fieldMatches({ $endsWith: '.js' }, { x: 'index.ts' })).toBe(false);
  });

  it('returns true with empty string suffix', () => {
    expect(fieldMatches({ $endsWith: '' }, { x: 'anything' })).toBe(true);
  });

  it('returns true for exact match (whole string as suffix)', () => {
    expect(fieldMatches({ $endsWith: 'hello' }, { x: 'hello' })).toBe(true);
  });

  it('returns false for a non-string value (number)', () => {
    expect(fieldMatches({ $endsWith: '34' }, { x: 1234 })).toBe(false);
  });

  it('returns false for null value', () => {
    expect(fieldMatches({ $endsWith: '' }, { x: null })).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(matched({ field: 'missing', operator: { $endsWith: 'x' } }, {})).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(fieldMatches({ $endsWith: '.TS' }, { x: 'index.ts' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// $glob operator
// ---------------------------------------------------------------------------

describe('$glob operator', () => {
  it('matches a simple file extension glob', () => {
    expect(fieldMatches({ $glob: '**/*.ts' }, { x: 'src/index.ts' })).toBe(true);
  });

  it('does not match a non-matching extension', () => {
    expect(fieldMatches({ $glob: '**/*.ts' }, { x: 'src/index.js' })).toBe(false);
  });

  it('matches a path-prefixed glob', () => {
    expect(fieldMatches({ $glob: 'src/**' }, { x: 'src/utils/helpers.ts' })).toBe(true);
  });

  it('does not match a path outside the glob scope', () => {
    expect(fieldMatches({ $glob: 'src/**' }, { x: 'test/utils/helpers.ts' })).toBe(false);
  });

  it('matches an exact filename', () => {
    expect(fieldMatches({ $glob: 'README.md' }, { x: 'README.md' })).toBe(true);
  });

  it('does not match a different filename with exact pattern', () => {
    expect(fieldMatches({ $glob: 'README.md' }, { x: 'readme.md' })).toBe(false);
  });

  it('matches a complex double-star pattern', () => {
    expect(
      fieldMatches({ $glob: '**/framework/packages/**' }, { x: '/repo/framework/packages/rules/src/index.ts' }),
    ).toBe(true);
  });

  it('returns false for a non-string value', () => {
    expect(fieldMatches({ $glob: '**/*.ts' }, { x: 42 })).toBe(false);
  });

  it('returns false for null value', () => {
    expect(fieldMatches({ $glob: '*' }, { x: null })).toBe(false);
  });

  it('returns false for undefined (missing field)', () => {
    expect(matched({ field: 'missing', operator: { $glob: '*' } }, {})).toBe(false);
  });

  it('matches a single-star pattern at a directory level', () => {
    expect(fieldMatches({ $glob: 'src/*/index.ts' }, { x: 'src/utils/index.ts' })).toBe(true);
  });

  it('does not match when single star skips directory separator', () => {
    // Single star does not match path separators by default in minimatch
    expect(fieldMatches({ $glob: 'src/*.ts' }, { x: 'src/utils/index.ts' })).toBe(false);
  });

  it('caches the same glob pattern (calling twice is idempotent)', () => {
    const pattern = '**/__tests__/**/*.test.ts';
    expect(fieldMatches({ $glob: pattern }, { x: '__tests__/rules/operators.test.ts' })).toBe(true);
    expect(fieldMatches({ $glob: pattern }, { x: '__tests__/rules/operators.test.ts' })).toBe(true);
  });
});
