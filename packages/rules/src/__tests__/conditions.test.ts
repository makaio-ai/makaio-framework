import { describe, expect, it } from 'vitest';
import type { Condition } from '../index.js';
import { errorOf, matched } from './support.js';

// ---------------------------------------------------------------------------
// Field condition — dot-notation path resolution
// ---------------------------------------------------------------------------

describe('field condition — dot-notation path resolution', () => {
  it('resolves a top-level field', () => {
    expect(matched({ field: 'status', operator: 'active' }, { status: 'active' })).toBe(true);
  });

  it('resolves a two-level nested path', () => {
    expect(matched({ field: 'a.b', operator: 'deep' }, { a: { b: 'deep' } })).toBe(true);
  });

  it('resolves a three-level nested path', () => {
    expect(matched({ field: 'a.b.c', operator: 42 }, { a: { b: { c: 42 } } })).toBe(true);
  });

  it('resolves array index as a path segment', () => {
    expect(matched({ field: 'items.0.name', operator: 'alpha' }, { items: [{ name: 'alpha' }] })).toBe(true);
  });

  it('returns undefined (fails match) when traversal stops at null', () => {
    expect(matched({ field: 'a.b', operator: { $exists: true } }, { a: null })).toBe(false);
  });

  it('returns undefined when traversal stops at undefined intermediate', () => {
    expect(matched({ field: 'a.b.c', operator: { $exists: true } }, { a: { b: undefined } })).toBe(false);
  });

  it('returns undefined for a completely missing field', () => {
    expect(matched({ field: 'nonexistent', operator: { $exists: true } }, {})).toBe(false);
  });

  it('returns undefined when a non-object blocks deeper traversal (primitive leaf)', () => {
    expect(matched({ field: 'leaf.child', operator: { $exists: false } }, { leaf: 'string-value' })).toBe(true);
  });

  it('resolves correctly when path contains a numeric-looking segment', () => {
    expect(matched({ field: 'map.123', operator: 'value' }, { map: { '123': 'value' } })).toBe(true);
  });

  it('returns undefined when root context is missing the first segment', () => {
    expect(matched({ field: 'x.y', operator: 'z' }, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound condition — $and
// ---------------------------------------------------------------------------

// Compound condition tests use explicit individual cases rather than
// table-driven it.each — each case has distinct boolean semantics that
// are clearer when the test title describes the specific scenario.
describe('$and compound condition', () => {
  it('returns true when all children are true', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 1 },
        { field: 'b', operator: 2 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false when one child is false', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 1 },
        { field: 'b', operator: 99 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(false);
  });

  it('returns false when all children are false', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 99 },
        { field: 'b', operator: 99 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(false);
  });

  it('does not hide an error behind a false first child', () => {
    // All operands are evaluated; the malformed $expr surfaces as an error.
    const condition: Condition = {
      $and: [{ field: 'a', operator: 'wrong' }, { $expr: '(' }],
    };
    const error = errorOf(condition, { a: 'right' });
    expect(error.path).toBe('$and[1].$expr');
    expect(error.message).not.toBe('');
  });

  it('evaluates second child when first succeeds (no short-circuit of truthy)', () => {
    const condition: Condition = {
      $and: [
        { field: 'a', operator: 'right' },
        { field: 'b', operator: 2 },
      ],
    };
    expect(matched(condition, { a: 'right', b: 2 })).toBe(true);
  });

  it('supports single-element $and', () => {
    const condition: Condition = { $and: [{ field: 'x', operator: 5 }] };
    expect(matched(condition, { x: 5 })).toBe(true);
  });

  it('supports $and nested inside another $and', () => {
    const condition: Condition = {
      $and: [
        {
          $and: [
            { field: 'a', operator: 1 },
            { field: 'b', operator: 2 },
          ],
        },
        { field: 'c', operator: 3 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2, c: 3 })).toBe(true);
    expect(matched(condition, { a: 1, b: 9, c: 3 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound condition — $or
// ---------------------------------------------------------------------------

describe('$or compound condition', () => {
  it('returns true when at least one child is true', () => {
    const condition: Condition = {
      $or: [
        { field: 'a', operator: 99 },
        { field: 'b', operator: 2 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(true);
  });

  it('returns false when all children are false', () => {
    const condition: Condition = {
      $or: [
        { field: 'a', operator: 99 },
        { field: 'b', operator: 99 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(false);
  });

  it('does not hide an error behind a true first child', () => {
    // All operands are evaluated; the malformed $expr surfaces as an error.
    const condition: Condition = {
      $or: [{ field: 'a', operator: 'right' }, { $expr: '(' }],
    };
    const error = errorOf(condition, { a: 'right' });
    expect(error.path).toBe('$or[1].$expr');
    expect(error.message).not.toBe('');
  });

  it('returns true when only the last child is true', () => {
    const condition: Condition = {
      $or: [
        { field: 'a', operator: 99 },
        { field: 'b', operator: 99 },
        { field: 'c', operator: 3 },
      ],
    };
    expect(matched(condition, { a: 1, b: 2, c: 3 })).toBe(true);
  });

  it('supports single-element $or', () => {
    const condition: Condition = { $or: [{ field: 'x', operator: 5 }] };
    expect(matched(condition, { x: 5 })).toBe(true);
  });

  it('supports $or nested inside $and', () => {
    const condition: Condition = {
      $and: [
        { field: 'env', operator: 'prod' },
        {
          $or: [
            { field: 'branch', operator: 'main' },
            { field: 'branch', operator: 'release' },
          ],
        },
      ],
    };
    expect(matched(condition, { env: 'prod', branch: 'main' })).toBe(true);
    expect(matched(condition, { env: 'prod', branch: 'feature' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound condition — $not
// ---------------------------------------------------------------------------

describe('$not compound condition', () => {
  it('negates a true field condition to false', () => {
    const condition: Condition = { $not: { field: 'status', operator: 'active' } };
    expect(matched(condition, { status: 'active' })).toBe(false);
  });

  it('negates a false field condition to true', () => {
    const condition: Condition = { $not: { field: 'status', operator: 'inactive' } };
    expect(matched(condition, { status: 'active' })).toBe(true);
  });

  it('double-negation restores the original boolean', () => {
    const condition: Condition = { $not: { $not: { field: 'x', operator: 1 } } };
    expect(matched(condition, { x: 1 })).toBe(true);
    expect(matched(condition, { x: 2 })).toBe(false);
  });

  it('negates a compound $and', () => {
    const condition: Condition = {
      $not: {
        $and: [
          { field: 'a', operator: 1 },
          { field: 'b', operator: 2 },
        ],
      },
    };
    expect(matched(condition, { a: 1, b: 2 })).toBe(false);
    expect(matched(condition, { a: 1, b: 9 })).toBe(true);
  });

  it('negates an $expr condition', () => {
    const condition: Condition = { $not: { $expr: 'score > 10' } };
    expect(matched(condition, { score: 5 })).toBe(true);
    expect(matched(condition, { score: 15 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deeply nested compounds
// ---------------------------------------------------------------------------

describe('deeply nested compound conditions', () => {
  it('evaluates a three-level $and > $or > $and correctly', () => {
    const condition: Condition = {
      $and: [
        { field: 'env', operator: 'prod' },
        {
          $or: [
            {
              $and: [
                { field: 'branch', operator: 'main' },
                { field: 'ready', operator: true },
              ],
            },
            { field: 'hotfix', operator: true },
          ],
        },
      ],
    };

    expect(matched(condition, { env: 'prod', branch: 'main', ready: true, hotfix: false })).toBe(true);
    expect(matched(condition, { env: 'prod', branch: 'feature', ready: false, hotfix: true })).toBe(true);
    expect(matched(condition, { env: 'prod', branch: 'feature', ready: false, hotfix: false })).toBe(false);
    expect(matched(condition, { env: 'staging', branch: 'main', ready: true, hotfix: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expression condition — $expr
// ---------------------------------------------------------------------------

describe('$expr expression condition', () => {
  it('evaluates a simple numeric comparison', () => {
    expect(matched({ $expr: 'score > 5' }, { score: 10 })).toBe(true);
    expect(matched({ $expr: 'score > 5' }, { score: 3 })).toBe(false);
  });

  it('evaluates a string equality expression', () => {
    expect(matched({ $expr: 'env == "prod"' }, { env: 'prod' })).toBe(true);
    expect(matched({ $expr: 'env == "prod"' }, { env: 'dev' })).toBe(false);
  });

  it('accesses nested context properties', () => {
    expect(matched({ $expr: 'meta.version > 2' }, { meta: { version: 3 } })).toBe(true);
    expect(matched({ $expr: 'meta.version > 2' }, { meta: { version: 1 } })).toBe(false);
  });

  it('evaluates a logical AND expression', () => {
    expect(matched({ $expr: 'a > 0 && b > 0' }, { a: 1, b: 1 })).toBe(true);
    expect(matched({ $expr: 'a > 0 && b > 0' }, { a: 1, b: 0 })).toBe(false);
  });

  it('evaluates a pipe transform expression (upper)', () => {
    expect(matched({ $expr: 'name|upper == "ALICE"' }, { name: 'alice' })).toBe(true);
    expect(matched({ $expr: 'name|upper == "ALICE"' }, { name: 'bob' })).toBe(false);
  });

  it('returns false when expression evaluates to a falsy non-boolean', () => {
    // 0 is falsy → Boolean(0) === false
    expect(matched({ $expr: '0' }, {})).toBe(false);
  });

  it('returns true when expression evaluates to a truthy non-boolean', () => {
    // 1 is truthy → Boolean(1) === true
    expect(matched({ $expr: '1' }, {})).toBe(true);
  });

  it('evaluates expression using full context object', () => {
    expect(matched({ $expr: 'count == 3' }, { count: 3, extra: 'ignored' })).toBe(true);
  });

  it('evaluates the same expression consistently across repeated evaluations', () => {
    const condition = { $expr: 'value * 2 == 4' };
    expect(matched(condition, { value: 2 })).toBe(true);
    expect(matched(condition, { value: 3 })).toBe(false);
    expect(matched(condition, { value: 2 })).toBe(true);
  });

  it('returns an error when expression is malformed', () => {
    const error = errorOf({ $expr: '(' }, {});
    expect(error.path).toBe('$expr');
    expect(error.message).not.toBe('');
  });

  it('returns an error on binary operator with missing operand', () => {
    const error = errorOf({ $expr: 'x +' }, {});
    expect(error.path).toBe('$expr');
    expect(error.message).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Mixed structural + expression conditions
// ---------------------------------------------------------------------------

describe('mixed field and expression conditions', () => {
  it('combines a field condition and $expr inside $and', () => {
    const condition: Condition = {
      $and: [{ field: 'env', operator: 'prod' }, { $expr: 'score >= 5' }],
    };
    expect(matched(condition, { env: 'prod', score: 5 })).toBe(true);
    expect(matched(condition, { env: 'prod', score: 4 })).toBe(false);
    expect(matched(condition, { env: 'dev', score: 10 })).toBe(false);
  });

  it('combines a field glob and $expr inside $or', () => {
    const condition: Condition = {
      $or: [{ field: 'path', operator: { $glob: '**/*.ts' } }, { $expr: 'forceInclude == true' }],
    };
    expect(matched(condition, { path: 'src/index.ts', forceInclude: false })).toBe(true);
    expect(matched(condition, { path: 'src/index.js', forceInclude: true })).toBe(true);
    expect(matched(condition, { path: 'src/index.js', forceInclude: false })).toBe(false);
  });

  it('uses $not around a $expr', () => {
    const condition: Condition = {
      $and: [{ field: 'status', operator: 'active' }, { $not: { $expr: 'disabled == true' } }],
    };
    expect(matched(condition, { status: 'active', disabled: false })).toBe(true);
    expect(matched(condition, { status: 'active', disabled: true })).toBe(false);
  });
});
