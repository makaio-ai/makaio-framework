import { describe, expect, it } from 'vitest';
import { evaluateRules, type Rule } from '../index.js';
import { makeRule } from './support.js';

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe('evaluateRules — basic matching', () => {
  it('returns an empty array when the rule list is empty', () => {
    expect(evaluateRules([], {})).toEqual({ matched: [], failed: [] });
  });

  it('returns a rule when its condition matches', () => {
    const rules = [makeRule('r1', { field: 'env', operator: 'prod' })];
    expect(evaluateRules(rules, { env: 'prod' }).matched.map((r) => r.id)).toEqual(['r1']);
  });

  it('returns no rules when no condition matches', () => {
    const rules = [makeRule('r1', { field: 'env', operator: 'prod' })];
    expect(evaluateRules(rules, { env: 'dev' }).matched).toHaveLength(0);
  });

  it('returns multiple rules when all conditions match', () => {
    const rules = [
      makeRule('r1', { field: 'env', operator: 'prod' }),
      makeRule('r2', { field: 'env', operator: 'prod' }),
    ];
    expect(evaluateRules(rules, { env: 'prod' }).matched.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('returns only matching rules from a mixed set', () => {
    const rules = [
      makeRule('match1', { field: 'env', operator: 'prod' }),
      makeRule('no-match', { field: 'env', operator: 'dev' }),
      makeRule('match2', { field: 'env', operator: 'prod' }),
    ];
    expect(evaluateRules(rules, { env: 'prod' }).matched.map((r) => r.id)).toEqual(['match1', 'match2']);
  });
});

// ---------------------------------------------------------------------------
// Disabled rule filtering
// ---------------------------------------------------------------------------

describe('evaluateRules — disabled rule filtering', () => {
  it('skips disabled rules by default', () => {
    const rules = [
      makeRule('enabled', { field: 'x', operator: 1 }, true),
      makeRule('disabled', { field: 'x', operator: 1 }, false),
    ];
    expect(evaluateRules(rules, { x: 1 }).matched.map((r) => r.id)).toEqual(['enabled']);
  });

  it('includes disabled rules when includeDisabled is true', () => {
    const rules = [
      makeRule('enabled', { field: 'x', operator: 1 }, true),
      makeRule('disabled', { field: 'x', operator: 1 }, false),
    ];
    const result = evaluateRules(rules, { x: 1 }, { includeDisabled: true }).matched;
    expect(result.map((r) => r.id)).toEqual(['enabled', 'disabled']);
  });

  it('returns empty array when all rules are disabled and includeDisabled is false', () => {
    const rules = [
      makeRule('d1', { field: 'x', operator: 1 }, false),
      makeRule('d2', { field: 'x', operator: 1 }, false),
    ];
    expect(evaluateRules(rules, { x: 1 }).matched).toHaveLength(0);
  });

  it('excludes disabled rules whose condition does not match even with includeDisabled', () => {
    const rules = [makeRule('disabled-no-match', { field: 'x', operator: 999 }, false)];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: true }).matched).toHaveLength(0);
  });

  it('only evaluates disabled rules that also match when includeDisabled is true', () => {
    const rules = [
      makeRule('d-match', { field: 'x', operator: 1 }, false),
      makeRule('d-no-match', { field: 'x', operator: 99 }, false),
    ];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: true }).matched.map((r) => r.id)).toEqual(['d-match']);
  });
});

// ---------------------------------------------------------------------------
// Input order preservation
// ---------------------------------------------------------------------------

describe('evaluateRules — input order preservation', () => {
  it('preserves the input order regardless of priority metadata', () => {
    // Rules are ordered in the array as second → first by priority value,
    // but evaluateRules must return them in the order they appear in the input.
    const rules = [
      makeRule('second', { field: 'env', operator: 'prod' }, true, 50),
      makeRule('first', { field: 'env', operator: 'prod' }, true, 0),
    ];
    expect(evaluateRules(rules, { env: 'prod' }).matched.map((r) => r.id)).toEqual(['second', 'first']);
  });

  it('does not sort by priority even when priority values differ greatly', () => {
    const rules = [
      makeRule('low', { field: 'flag', operator: true }, true, 1000),
      makeRule('medium', { field: 'flag', operator: true }, true, 500),
      makeRule('high', { field: 'flag', operator: true }, true, 1),
    ];
    expect(evaluateRules(rules, { flag: true }).matched.map((r) => r.id)).toEqual(['low', 'medium', 'high']);
  });

  it('returns a readonly-typed input without mutation', () => {
    const rules = Object.freeze([
      makeRule('r1', { field: 'x', operator: 1 }),
      makeRule('r2', { field: 'x', operator: 1 }),
    ]) as readonly Rule<{ label: string }>[];
    expect(evaluateRules(rules, { x: 1 }).matched).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

describe('evaluateRules — default options', () => {
  it('behaves identically whether options is omitted or explicitly {}', () => {
    const rules = [makeRule('r', { field: 'x', operator: 1 }, false)];
    expect(evaluateRules(rules, { x: 1 }).matched).toHaveLength(0);
    expect(evaluateRules(rules, { x: 1 }, {}).matched).toHaveLength(0);
  });

  it('treats includeDisabled: false explicitly the same as omitting it', () => {
    const rules = [makeRule('r', { field: 'x', operator: 1 }, false)];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: false }).matched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failed conditions
// ---------------------------------------------------------------------------

describe('evaluateRules — failed conditions', () => {
  it('reports a rule with a malformed $expr in failed', () => {
    const broken = makeRule('broken', { $expr: '(' });
    const result = evaluateRules([broken], {});
    expect(result.matched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.rule).toBe(broken);
    expect(result.failed[0]?.error.path).toBe('$expr');
    expect(result.failed[0]?.error.message).not.toBe('');
  });

  it('keeps the other rules in matched when one rule fails', () => {
    const rules = [
      makeRule('before', { field: 'x', operator: 1 }),
      makeRule('broken', { $expr: '(' }),
      makeRule('after', { field: 'x', operator: 1 }),
      makeRule('no-match', { field: 'x', operator: 2 }),
    ];
    const result = evaluateRules(rules, { x: 1 });
    expect(result.matched.map((r) => r.id)).toEqual(['before', 'after']);
    expect(result.failed.map((f) => f.rule.id)).toEqual(['broken']);
  });

  it('lists several failed rules in input order', () => {
    const rules = [
      makeRule('b1', { $expr: '(' }),
      makeRule('ok', { field: 'x', operator: 1 }),
      makeRule('b2', { $and: [{ field: 'x', operator: 1 }, { $expr: '(' }] }),
    ];
    const result = evaluateRules(rules, { x: 1 });
    expect(result.failed.map((f) => f.rule.id)).toEqual(['b1', 'b2']);
    expect(result.failed[1]?.error.path).toBe('$and[1].$expr');
    expect(result.matched.map((r) => r.id)).toEqual(['ok']);
  });

  it('does not let a failing operand hide behind a non-matching sibling', () => {
    const rules = [makeRule('r', { $and: [{ field: 'x', operator: 99 }, { $expr: '(' }] })];
    const result = evaluateRules(rules, { x: 1 });
    expect(result.matched).toEqual([]);
    expect(result.failed.map((f) => f.rule.id)).toEqual(['r']);
  });

  it('does not throw', () => {
    expect(() => evaluateRules([makeRule('broken', { $expr: '(' })], {})).not.toThrow();
  });

  it('shows a disabled rule with a malformed $expr nowhere by default', () => {
    const rules = [makeRule('broken-disabled', { $expr: '(' }, false)];
    expect(evaluateRules(rules, {})).toEqual({ matched: [], failed: [] });
  });

  it('reports a disabled rule with a malformed $expr in failed when includeDisabled is true', () => {
    const rules = [makeRule('broken-disabled', { $expr: '(' }, false)];
    const result = evaluateRules(rules, {}, { includeDisabled: true });
    expect(result.matched).toEqual([]);
    expect(result.failed.map((f) => f.rule.id)).toEqual(['broken-disabled']);
    expect(result.failed[0]?.error.path).toBe('$expr');
  });
});

// ---------------------------------------------------------------------------
// Rich action payloads
// ---------------------------------------------------------------------------

describe('evaluateRules — rich action payloads', () => {
  it('preserves the full action payload in the matched rule', () => {
    const rule: Rule<{ code: number; tags: string[] }> = {
      id: 'rich',
      name: 'rich rule',
      condition: { field: 'env', operator: 'prod' },
      action: { code: 200, tags: ['a', 'b'] },
      priority: 5,
      enabled: true,
    };
    const [first] = evaluateRules([rule], { env: 'prod' }).matched;
    expect(first?.action).toEqual({ code: 200, tags: ['a', 'b'] });
  });
});
