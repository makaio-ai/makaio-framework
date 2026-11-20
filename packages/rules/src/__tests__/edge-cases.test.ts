import type { JsonValue } from '@makaio/contracts/shared';
import { describe, expect, it } from 'vitest';
import { evaluateRules, type Condition, type Rule } from '../index.js';
import { errorOf, matched } from './support.js';

const CACHE_STRESS_COUNT = 260;

/**
 * Run a cache-eviction stress loop with a shared count across cache tests.
 * @param callback - Per-iteration assertion body.
 */
function runCacheStress(callback: (index: number) => void): void {
  for (let i = 0; i < CACHE_STRESS_COUNT; i++) {
    callback(i);
  }
}

/**
 * Assert a single condition evaluation result.
 * @param condition - Condition to evaluate.
 * @param context - Evaluation context.
 * @param expected - Expected boolean result.
 */
function expectEvaluation(condition: Condition, context: Record<string, unknown>, expected: boolean): void {
  expect(matched(condition, context)).toBe(expected);
}

// ---------------------------------------------------------------------------
// Empty context
// ---------------------------------------------------------------------------

describe('edge cases — empty context', () => {
  it('field condition against empty context returns false for equality', () => {
    expect(matched({ field: 'x', operator: 'value' }, {})).toBe(false);
  });

  it('$exists: false matches a missing field in an empty context', () => {
    expect(matched({ field: 'x', operator: { $exists: false } }, {})).toBe(true);
  });

  it('$and with failing field condition against empty context returns false', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 1 },
        { field: 'b', operator: 2 },
      ],
    };
    expect(matched(condition, {})).toBe(false);
  });

  it('$expr accessing missing variable evaluates without throwing', () => {
    // jexl returns undefined for missing variables; Boolean(undefined) = false
    expect(matched({ $expr: 'missing > 0' }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deeply nested context
// ---------------------------------------------------------------------------

describe('edge cases — deeply nested context', () => {
  const deep = {
    l1: { l2: { l3: { l4: { l5: 'found' } } } },
  };

  it('resolves a five-level deep path', () => {
    expect(matched({ field: 'l1.l2.l3.l4.l5', operator: 'found' }, deep)).toBe(true);
  });

  it('returns false for a six-level path on a five-level deep object', () => {
    expect(matched({ field: 'l1.l2.l3.l4.l5.l6', operator: { $exists: true } }, deep)).toBe(false);
  });

  it('traversal stops at null mid-path and reports missing', () => {
    const ctx = { a: { b: null } };
    expect(matched({ field: 'a.b.c', operator: { $exists: true } }, ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context with many fields (stress test for field resolution)
// ---------------------------------------------------------------------------

describe('edge cases — large context', () => {
  it('resolves a field from a context with 100 keys', () => {
    const ctx: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      ctx[`field_${String(i)}`] = i;
    }
    expect(matched({ field: 'field_50', operator: 50 }, ctx)).toBe(true);
    expect(matched({ field: 'field_99', operator: 99 }, ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LRU cache behavior — glob cache
// ---------------------------------------------------------------------------

describe('edge cases — glob LRU cache', () => {
  it('evaluates the same glob pattern consistently across many calls', () => {
    const pattern = '**/*.spec.ts';
    for (let i = 0; i < 10; i++) {
      expect(matched({ field: 'file', operator: { $glob: pattern } }, { file: 'src/foo.spec.ts' })).toBe(true);
    }
  });

  it('evaluates many distinct glob patterns without error (exercises eviction)', () => {
    // Create enough distinct patterns (> CACHE_LIMIT of 256) to trigger LRU eviction.
    runCacheStress((i) => {
      const pattern = `prefix_${String(i)}/**/*.ts`;
      const path = `prefix_${String(i)}/src/file.ts`;
      expect(matched({ field: 'p', operator: { $glob: pattern } }, { p: path })).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// LRU cache behavior — expression cache
// ---------------------------------------------------------------------------

describe('edge cases — expression LRU cache', () => {
  it('evaluates many distinct expressions without error (exercises eviction)', () => {
    runCacheStress((i) => {
      const expr = `value == ${String(i)}`;
      expect(matched({ $expr: expr }, { value: i })).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Boundary values — numbers
// ---------------------------------------------------------------------------

describe('edge cases — numeric boundary values', () => {
  it('matches 0 exactly', () => {
    expect(matched({ field: 'n', operator: 0 }, { n: 0 })).toBe(true);
  });

  it('does not match 0 against false (strict equality)', () => {
    expect(matched({ field: 'n', operator: 0 }, { n: false })).toBe(false);
  });

  it('matches negative numbers', () => {
    expect(matched({ field: 'n', operator: -1 }, { n: -1 })).toBe(true);
  });

  it('matches a floating-point value exactly', () => {
    expect(matched({ field: 'n', operator: 3.14 }, { n: 3.14 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary values — empty strings
// ---------------------------------------------------------------------------

describe('edge cases — empty string values', () => {
  it('implicit equality matches an empty string', () => {
    expectEvaluation({ field: 's', operator: '' }, { s: '' }, true);
  });

  it('$startsWith with empty prefix on empty string returns true', () => {
    expectEvaluation({ field: 's', operator: { $startsWith: '' } }, { s: '' }, true);
  });

  it('$endsWith with empty suffix on empty string returns true', () => {
    expectEvaluation({ field: 's', operator: { $endsWith: '' } }, { s: '' }, true);
  });

  it('$in: empty array does not match an empty string', () => {
    expectEvaluation({ field: 's', operator: { $in: [] } }, { s: '' }, false);
  });

  it('$exists: true matches an empty string (it is present)', () => {
    expectEvaluation({ field: 's', operator: { $exists: true } }, { s: '' }, true);
  });
});

// ---------------------------------------------------------------------------
// Boolean fields
// ---------------------------------------------------------------------------

describe('edge cases — boolean context values', () => {
  it('matches explicit true with implicit equality', () => {
    expectEvaluation({ field: 'flag', operator: true }, { flag: true }, true);
  });

  it('does not match false with operator true', () => {
    expectEvaluation({ field: 'flag', operator: true }, { flag: false }, false);
  });

  it('$exists: true matches false boolean (false is present)', () => {
    expectEvaluation({ field: 'flag', operator: { $exists: true } }, { flag: false }, true);
  });
});

// ---------------------------------------------------------------------------
// evaluateRules with no matching rules
// ---------------------------------------------------------------------------

describe('edge cases — evaluateRules with no matches', () => {
  it('reports no matched and no failed rules when no condition matches', () => {
    const rules: Rule<{ label: string }>[] = [
      {
        id: '1',
        name: '1',
        condition: { field: 'x', operator: 99 },
        action: { label: '1' },
        priority: 0,
        enabled: true,
      },
      {
        id: '2',
        name: '2',
        condition: { field: 'y', operator: 'nope' },
        action: { label: '2' },
        priority: 0,
        enabled: true,
      },
    ];
    const outcome = evaluateRules(rules, { x: 1, y: 'yes' });
    expect(outcome.matched).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// $not with nested compound
// ---------------------------------------------------------------------------

describe('edge cases — $not with nested compound', () => {
  it('negates an $or where all children would match', () => {
    const condition: Condition = {
      $not: {
        $or: [
          { field: 'a', operator: 1 },
          { field: 'b', operator: 2 },
        ],
      },
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(false);
    expect(matched(condition, { a: 99, b: 99 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Truthy vs falsy expression result coercion
// ---------------------------------------------------------------------------

describe('edge cases — $expr result coercion', () => {
  it('empty-string equality expression is truthy (jexl: "" == "" → true)', () => {
    expect(matched({ $expr: '"" == ""' }, {})).toBe(true);
  });

  it('empty-string expression result is falsy after boolean coercion', () => {
    expect(matched({ $expr: '""' }, {})).toBe(false);
  });

  it('undefined variable equals null in jexl loose equality (returns true)', () => {
    // In jexl, undefined == null evaluates truthy (loose equality semantics),
    // so Boolean(true) === true.
    expect(matched({ $expr: 'missing == null' }, {})).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inherited property paths
// ---------------------------------------------------------------------------

describe('edge cases — inherited property paths', () => {
  const context = { a: { b: 1 }, items: [{ name: 'first' }] };

  it.each(['constructor', '__proto__', 'toString', 'a.hasOwnProperty'])('treats %s as absent', (field) => {
    expectEvaluation({ field, operator: { $exists: false } }, context, true);
    expectEvaluation({ field, operator: { $exists: true } }, context, false);
    expectEvaluation({ field, operator: { $eq: 'x' } }, context, false);
    expectEvaluation({ field, operator: { $ne: 'x' } }, context, true);
  });

  it('still indexes arrays with numeric segments', () => {
    expectEvaluation({ field: 'items.0.name', operator: 'first' }, context, true);
  });
});

// ---------------------------------------------------------------------------
// Evaluation never throws
// ---------------------------------------------------------------------------

describe('edge cases — evaluation never throws', () => {
  it('reports a throwing own getter as an error at the field node', () => {
    const context = {
      get boom(): never {
        throw new Error('getter failed');
      },
    };
    expect(errorOf({ field: 'boom', operator: 'x' }, context)).toEqual({ path: '', message: 'getter failed' });
  });

  it('reports a throwing Proxy trap with the path of the failing node', () => {
    const context = {
      p: new Proxy(
        { x: 1 },
        {
          get(): never {
            throw new Error('trap failed');
          },
        },
      ),
    };
    expect(errorOf({ $and: [{ field: 'p.x', operator: 'x' }] }, context)).toEqual({
      path: '$and[0]',
      message: 'trap failed',
    });
  });

  it('reports a cyclic value compared with a cyclic operand as an error', () => {
    const operand: { [key: string]: JsonValue } = {};
    operand['self'] = operand;
    const value: Record<string, unknown> = {};
    value['self'] = value;
    expect(errorOf({ field: 'v', operator: { $eq: operand } }, { v: value }).path).toBe('');
  });

  it('reports a $glob pattern over 65,536 characters as an error', () => {
    const pattern = 'a'.repeat(65_537);
    expect(errorOf({ field: 'f', operator: { $glob: pattern } }, { f: 'a' }).path).toBe('');
  });
});
