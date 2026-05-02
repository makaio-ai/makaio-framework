import { describe, expect, it } from 'vitest';
import { evaluate, evaluateRules, type Condition, type Rule } from '../index.js';

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
  expect(evaluate(condition, context)).toBe(expected);
}

// ---------------------------------------------------------------------------
// Empty context
// ---------------------------------------------------------------------------

describe('edge cases — empty context', () => {
  it('field condition against empty context returns false for equality', () => {
    expect(evaluate({ field: 'x', operator: 'value' }, {})).toBe(false);
  });

  it('$exists: false matches a missing field in an empty context', () => {
    expect(evaluate({ field: 'x', operator: { $exists: false } }, {})).toBe(true);
  });

  it('$and with failing field condition against empty context returns false', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 1 },
        { field: 'b', operator: 2 },
      ],
    };
    expect(evaluate(condition, {})).toBe(false);
  });

  it('$expr accessing missing variable evaluates without throwing', () => {
    // jexl returns undefined for missing variables; Boolean(undefined) = false
    expect(evaluate({ $expr: 'missing > 0' }, {})).toBe(false);
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
    expect(evaluate({ field: 'l1.l2.l3.l4.l5', operator: 'found' }, deep)).toBe(true);
  });

  it('returns false for a six-level path on a five-level deep object', () => {
    expect(evaluate({ field: 'l1.l2.l3.l4.l5.l6', operator: { $exists: true } }, deep)).toBe(false);
  });

  it('traversal stops at null mid-path and reports missing', () => {
    const ctx = { a: { b: null } };
    expect(evaluate({ field: 'a.b.c', operator: { $exists: true } }, ctx)).toBe(false);
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
    expect(evaluate({ field: 'field_50', operator: 50 }, ctx)).toBe(true);
    expect(evaluate({ field: 'field_99', operator: 99 }, ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LRU cache behavior — glob cache
// ---------------------------------------------------------------------------

describe('edge cases — glob LRU cache', () => {
  it('evaluates the same glob pattern consistently across many calls', () => {
    const pattern = '**/*.spec.ts';
    for (let i = 0; i < 10; i++) {
      expect(evaluate({ field: 'file', operator: { $glob: pattern } }, { file: 'src/foo.spec.ts' })).toBe(true);
    }
  });

  it('evaluates many distinct glob patterns without error (exercises eviction)', () => {
    // Create enough distinct patterns (> CACHE_LIMIT of 256) to trigger LRU eviction.
    runCacheStress((i) => {
      const pattern = `prefix_${String(i)}/**/*.ts`;
      const path = `prefix_${String(i)}/src/file.ts`;
      expect(evaluate({ field: 'p', operator: { $glob: pattern } }, { p: path })).toBe(true);
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
      expect(evaluate({ $expr: expr }, { value: i })).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Boundary values — numbers
// ---------------------------------------------------------------------------

describe('edge cases — numeric boundary values', () => {
  it('matches 0 exactly', () => {
    expect(evaluate({ field: 'n', operator: 0 }, { n: 0 })).toBe(true);
  });

  it('does not match 0 against false (strict equality)', () => {
    expect(evaluate({ field: 'n', operator: 0 }, { n: false })).toBe(false);
  });

  it('matches negative numbers', () => {
    expect(evaluate({ field: 'n', operator: -1 }, { n: -1 })).toBe(true);
  });

  it('matches a floating-point value exactly', () => {
    expect(evaluate({ field: 'n', operator: 3.14 }, { n: 3.14 })).toBe(true);
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
  it('returns empty array when no rule conditions match', () => {
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
    expect(evaluateRules(rules, { x: 1, y: 'yes' })).toHaveLength(0);
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
    expect(evaluate(condition, { a: 1, b: 2 })).toBe(false);
    expect(evaluate(condition, { a: 99, b: 99 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Truthy vs falsy expression result coercion
// ---------------------------------------------------------------------------

describe('edge cases — $expr result coercion', () => {
  it('empty-string equality expression is truthy (jexl: "" == "" → true)', () => {
    expect(evaluate({ $expr: '"" == ""' }, {})).toBe(true);
  });

  it('empty-string expression result is falsy after boolean coercion', () => {
    expect(evaluate({ $expr: '""' }, {})).toBe(false);
  });

  it('undefined variable equals null in jexl loose equality (returns true)', () => {
    // In jexl, undefined == null evaluates truthy (loose equality semantics),
    // so Boolean(true) === true.
    expect(evaluate({ $expr: 'missing == null' }, {})).toBe(true);
  });
});
