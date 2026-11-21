import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluator.js';
import type { Condition } from '../types.js';
import { errorOf, matched } from './support.js';

const ctx = { order: { state: 'open', total: 5 } };

const T: Condition = { field: 'order.state', operator: 'open' };
const F: Condition = { field: 'order.state', operator: 'closed' };
/** Fails at compile time. */
const E: Condition = { $expr: '(' };
/** Compiles, fails only at run time: `parseJson` is registered but throws on malformed JSON. */
const RT: Condition = { $expr: "'{bad'|parseJson" };

describe('evaluation outcome', () => {
  describe('$not', () => {
    it('keeps an error an error', () => {
      expect(errorOf({ $not: E }, ctx).path).toBe('$not.$expr');
    });

    it('negates a match as usual', () => {
      expect(matched({ $not: T }, ctx)).toBe(false);
      expect(matched({ $not: F }, ctx)).toBe(true);
    });
  });

  describe('$and', () => {
    it('is an error for [error, false]', () => {
      expect(errorOf({ $and: [E, F] }, ctx).path).toBe('$and[0].$expr');
    });

    it('is an error for [false, error]', () => {
      expect(errorOf({ $and: [F, E] }, ctx).path).toBe('$and[1].$expr');
    });

    it('is an error for [true, error]', () => {
      expect(errorOf({ $and: [T, E] }, ctx).path).toBe('$and[1].$expr');
    });

    it('uses the usual logic without errors', () => {
      expect(matched({ $and: [T, T] }, ctx)).toBe(true);
      expect(matched({ $and: [T, F] }, ctx)).toBe(false);
      expect(matched({ $and: [F, F] }, ctx)).toBe(false);
    });
  });

  describe('$or', () => {
    it('is an error for [true, error]', () => {
      expect(errorOf({ $or: [T, E] }, ctx).path).toBe('$or[1].$expr');
    });

    it('is an error for [error, true]', () => {
      expect(errorOf({ $or: [E, T] }, ctx).path).toBe('$or[0].$expr');
    });

    it('is an error for [false, error]', () => {
      expect(errorOf({ $or: [F, E] }, ctx).path).toBe('$or[1].$expr');
    });

    it('uses the usual logic without errors', () => {
      expect(matched({ $or: [T, F] }, ctx)).toBe(true);
      expect(matched({ $or: [F, T] }, ctx)).toBe(true);
      expect(matched({ $or: [F, F] }, ctx)).toBe(false);
    });
  });

  describe('several errors', () => {
    it('reports the first by position in $and', () => {
      expect(errorOf({ $and: [T, E, RT] }, ctx).path).toBe('$and[1].$expr');
    });

    it('reports the first by position in $or', () => {
      expect(errorOf({ $or: [F, RT, E] }, ctx).path).toBe('$or[1].$expr');
    });

    it('reports the first by position across nesting', () => {
      const condition: Condition = { $and: [{ $or: [F, { $not: E }] }, RT] };
      expect(errorOf(condition, ctx).path).toBe('$and[0].$or[1].$not.$expr');
    });
  });

  describe('operand order', () => {
    const cases: Array<[string, Condition, Condition]> = [
      ['$and with an error and false', { $and: [E, F] }, { $and: [F, E] }],
      ['$and with an error and true', { $and: [E, T] }, { $and: [T, E] }],
      ['$or with an error and true', { $or: [E, T] }, { $or: [T, E] }],
      ['$or with an error and false', { $or: [E, F] }, { $or: [F, E] }],
      ['$and without errors', { $and: [T, F] }, { $and: [F, T] }],
      ['$or without errors', { $or: [T, F] }, { $or: [F, T] }],
    ];

    it.each(cases)('gives the same kind of result for swapped operands: %s', (_name, a, b) => {
      const first = evaluate(a, ctx);
      const second = evaluate(b, ctx);
      expect('error' in first).toBe('error' in second);
      if ('matched' in first && 'matched' in second) {
        expect(first.matched).toBe(second.matched);
      }
    });
  });

  describe('error path', () => {
    it('is empty-rooted for a top-level expression', () => {
      expect(errorOf(E, ctx).path).toBe('$expr');
    });

    it('locates the failing node in a nested condition', () => {
      const condition: Condition = { $and: [T, { $or: [F, { $not: { $and: [T, E] } }] }] };
      const error = errorOf(condition, ctx);
      expect(error.path).toBe('$and[1].$or[1].$not.$and[1].$expr');
      expect(error.message).not.toBe('');
    });
  });

  describe('run-time expression failure', () => {
    it('is an error, not only a syntax failure', () => {
      const error = errorOf(RT, ctx);
      expect(error.path).toBe('$expr');
      expect(error.message).not.toBe('');
    });

    it('propagates through $not and $or', () => {
      expect(errorOf({ $not: RT }, ctx).path).toBe('$not.$expr');
      expect(errorOf({ $or: [T, RT] }, ctx).path).toBe('$or[1].$expr');
    });
  });

  describe('evaluate does not throw', () => {
    const conditions: Condition[] = [
      E,
      RT,
      { $not: E },
      { $and: [E, F] },
      { $and: [F, E] },
      { $or: [T, E] },
      { $or: [E, T] },
      { $or: [F, E] },
      { $and: [E, RT] },
      { $and: [T, { $or: [F, { $not: RT }] }] },
    ];

    it.each(
      conditions.map((condition) => [JSON.stringify(condition), condition] as const),
    )('returns an error outcome for %s', (_name, condition) => {
      expect(() => evaluate(condition, ctx)).not.toThrow();
      expect(evaluate(condition, ctx)).toHaveProperty('error');
    });
  });
});
