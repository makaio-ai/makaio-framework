import { describe, it, expect } from 'bun:test';
import { isOperatorObject, type FilterOperator } from '../types/filter.js';

describe('FilterOperator types', () => {
  describe('isOperatorObject', () => {
    it('should recognize $startsWith as operator object', () => {
      const op: FilterOperator = { $startsWith: '.git/' };
      expect(isOperatorObject(op)).toBe(true);
    });

    it('should recognize $endsWith as operator object', () => {
      const op: FilterOperator = { $endsWith: '.ts' };
      expect(isOperatorObject(op)).toBe(true);
    });

    it('should still recognize existing operators', () => {
      expect(isOperatorObject({ $in: ['a', 'b'] })).toBe(true);
      expect(isOperatorObject({ $ne: 'x' })).toBe(true);
      expect(isOperatorObject({ $exists: true })).toBe(true);
    });

    it('should reject plain values', () => {
      expect(isOperatorObject('string' as FilterOperator)).toBe(false);
      expect(isOperatorObject(123 as FilterOperator)).toBe(false);
      expect(isOperatorObject(null as FilterOperator)).toBe(false);
    });
  });
});
