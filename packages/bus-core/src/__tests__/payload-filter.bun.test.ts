import { describe, it, expect } from 'bun:test';
import { matchesFilter, getPath } from '../utils/payload-filter.js';

describe('payload-filter', () => {
  describe('getPath', () => {
    it('should get nested values', () => {
      const obj = { a: { b: { c: 'value' } } };
      expect(getPath(obj, 'a.b.c')).toBe('value');
    });

    it('should return undefined for missing paths', () => {
      expect(getPath({ a: 1 }, 'b')).toBeUndefined();
    });
  });

  describe('matchesFilter with $startsWith', () => {
    it('should match string prefix', () => {
      const payload = { path: '.git/refs/heads/main' };
      expect(matchesFilter(payload, { path: { $startsWith: '.git/' } })).toBe(true);
    });

    it('should not match non-matching prefix', () => {
      const payload = { path: 'src/index.ts' };
      expect(matchesFilter(payload, { path: { $startsWith: '.git/' } })).toBe(false);
    });

    it('should return false for non-string values', () => {
      const payload = { path: 123 };
      expect(matchesFilter(payload, { path: { $startsWith: '.git/' } })).toBe(false);
    });

    it('should return false for undefined values', () => {
      const payload = { other: 'value' };
      expect(matchesFilter(payload, { path: { $startsWith: '.git/' } })).toBe(false);
    });
  });

  describe('matchesFilter with $endsWith', () => {
    it('should match string suffix', () => {
      const payload = { path: 'src/index.ts' };
      expect(matchesFilter(payload, { path: { $endsWith: '.ts' } })).toBe(true);
    });

    it('should not match non-matching suffix', () => {
      const payload = { path: 'src/index.js' };
      expect(matchesFilter(payload, { path: { $endsWith: '.ts' } })).toBe(false);
    });

    it('should return false for non-string values', () => {
      const payload = { path: null };
      expect(matchesFilter(payload, { path: { $endsWith: '.ts' } })).toBe(false);
    });
  });

  describe('matchesFilter with combined operators', () => {
    it('should AND multiple conditions', () => {
      const payload = { path: '.git/refs/heads/main', kind: 'change' };
      expect(
        matchesFilter(payload, {
          path: { $startsWith: '.git/' },
          kind: 'change',
        }),
      ).toBe(true);
    });

    it('should fail if any condition fails', () => {
      const payload = { path: '.git/refs/heads/main', kind: 'delete' };
      expect(
        matchesFilter(payload, {
          path: { $startsWith: '.git/' },
          kind: 'change',
        }),
      ).toBe(false);
    });
  });
});
