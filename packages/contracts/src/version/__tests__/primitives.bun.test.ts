import { describe, expect, it } from 'bun:test';

import { isUniversalRange, VersionLiteralSchema, VersionRangeSchema } from '../primitives.js';

describe('VersionRangeSchema', () => {
  it('accepts valid semver ranges', () => {
    const valid = ['>=1.0.0 <2.0.0', '^1.5.0', '~2.3.0', '>=1.0.0', '*', '1.x'];
    for (const range of valid) {
      expect(VersionRangeSchema.safeParse(range).success, `should accept "${range}"`).toBe(true);
    }
  });

  it('rejects invalid semver ranges', () => {
    const invalid = ['', 'not-a-range', '>=', 'abc.def.ghi'];
    for (const range of invalid) {
      expect(VersionRangeSchema.safeParse(range).success, `should reject "${range}"`).toBe(false);
    }
  });

  it('rejects whitespace-only strings', () => {
    expect(VersionRangeSchema.safeParse(' ').success).toBe(false);
    expect(VersionRangeSchema.safeParse('  ').success).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(VersionRangeSchema.safeParse(123).success).toBe(false);
    expect(VersionRangeSchema.safeParse(null).success).toBe(false);
  });
});

describe('isUniversalRange', () => {
  it('recognizes semver wildcard equivalents', () => {
    for (const range of ['*', '>=0.0.0', '>=0.0.0-0']) {
      expect(isUniversalRange(range), `should treat "${range}" as universal`).toBe(true);
    }
  });

  it('rejects constrained ranges', () => {
    expect(isUniversalRange('>=1.0.0')).toBe(false);
    expect(isUniversalRange('^1.2.3')).toBe(false);
  });
});

describe('VersionLiteralSchema', () => {
  it('accepts valid semver versions', () => {
    const valid = ['1.0.0', '0.1.0', '2.3.4-beta.1', '1.0.0+build.123'];
    for (const version of valid) {
      expect(VersionLiteralSchema.safeParse(version).success, `should accept "${version}"`).toBe(true);
    }
  });

  it('rejects invalid semver versions', () => {
    const invalid = ['', '1.0', 'v1.0.0', '>=1.0.0', 'not-a-version'];
    for (const version of invalid) {
      expect(VersionLiteralSchema.safeParse(version).success, `should reject "${version}"`).toBe(false);
    }
  });
});
