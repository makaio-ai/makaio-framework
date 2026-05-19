import { describe, expect, it } from 'bun:test';
import { evaluateRules, type Condition, type Rule } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal rule with a label action.
 * @param id - Rule identifier (also used as name and label)
 * @param condition - Predicate that determines whether the rule matches
 * @param enabled - Whether the rule is active; defaults to true
 * @param priority - Consumer-owned sort hint; defaults to 0
 * @returns Fully typed Rule object
 */
function makeRule(id: string, condition: Condition, enabled = true, priority = 0): Rule<{ label: string }> {
  return { id, name: id, condition, action: { label: id }, priority, enabled };
}

// ---------------------------------------------------------------------------
// Basic matching
// ---------------------------------------------------------------------------

describe('evaluateRules — basic matching', () => {
  it('returns an empty array when the rule list is empty', () => {
    expect(evaluateRules([], {})).toEqual([]);
  });

  it('returns a rule when its condition matches', () => {
    const rules = [makeRule('r1', { field: 'env', operator: 'prod' })];
    expect(evaluateRules(rules, { env: 'prod' }).map((r) => r.id)).toEqual(['r1']);
  });

  it('returns no rules when no condition matches', () => {
    const rules = [makeRule('r1', { field: 'env', operator: 'prod' })];
    expect(evaluateRules(rules, { env: 'dev' })).toHaveLength(0);
  });

  it('returns multiple rules when all conditions match', () => {
    const rules = [
      makeRule('r1', { field: 'env', operator: 'prod' }),
      makeRule('r2', { field: 'env', operator: 'prod' }),
    ];
    expect(evaluateRules(rules, { env: 'prod' }).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('returns only matching rules from a mixed set', () => {
    const rules = [
      makeRule('match1', { field: 'env', operator: 'prod' }),
      makeRule('no-match', { field: 'env', operator: 'dev' }),
      makeRule('match2', { field: 'env', operator: 'prod' }),
    ];
    expect(evaluateRules(rules, { env: 'prod' }).map((r) => r.id)).toEqual(['match1', 'match2']);
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
    expect(evaluateRules(rules, { x: 1 }).map((r) => r.id)).toEqual(['enabled']);
  });

  it('includes disabled rules when includeDisabled is true', () => {
    const rules = [
      makeRule('enabled', { field: 'x', operator: 1 }, true),
      makeRule('disabled', { field: 'x', operator: 1 }, false),
    ];
    const result = evaluateRules(rules, { x: 1 }, { includeDisabled: true });
    expect(result.map((r) => r.id)).toEqual(['enabled', 'disabled']);
  });

  it('returns empty array when all rules are disabled and includeDisabled is false', () => {
    const rules = [
      makeRule('d1', { field: 'x', operator: 1 }, false),
      makeRule('d2', { field: 'x', operator: 1 }, false),
    ];
    expect(evaluateRules(rules, { x: 1 })).toHaveLength(0);
  });

  it('excludes disabled rules whose condition does not match even with includeDisabled', () => {
    const rules = [makeRule('disabled-no-match', { field: 'x', operator: 999 }, false)];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: true })).toHaveLength(0);
  });

  it('only evaluates disabled rules that also match when includeDisabled is true', () => {
    const rules = [
      makeRule('d-match', { field: 'x', operator: 1 }, false),
      makeRule('d-no-match', { field: 'x', operator: 99 }, false),
    ];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: true }).map((r) => r.id)).toEqual(['d-match']);
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
    expect(evaluateRules(rules, { env: 'prod' }).map((r) => r.id)).toEqual(['second', 'first']);
  });

  it('does not sort by priority even when priority values differ greatly', () => {
    const rules = [
      makeRule('low', { field: 'flag', operator: true }, true, 1000),
      makeRule('medium', { field: 'flag', operator: true }, true, 500),
      makeRule('high', { field: 'flag', operator: true }, true, 1),
    ];
    expect(evaluateRules(rules, { flag: true }).map((r) => r.id)).toEqual(['low', 'medium', 'high']);
  });

  it('returns a readonly-typed input without mutation', () => {
    const rules = Object.freeze([
      makeRule('r1', { field: 'x', operator: 1 }),
      makeRule('r2', { field: 'x', operator: 1 }),
    ]) as readonly Rule<{ label: string }>[];
    expect(evaluateRules(rules, { x: 1 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

describe('evaluateRules — default options', () => {
  it('behaves identically whether options is omitted or explicitly {}', () => {
    const rules = [makeRule('r', { field: 'x', operator: 1 }, false)];
    expect(evaluateRules(rules, { x: 1 })).toHaveLength(0);
    expect(evaluateRules(rules, { x: 1 }, {})).toHaveLength(0);
  });

  it('treats includeDisabled: false explicitly the same as omitting it', () => {
    const rules = [makeRule('r', { field: 'x', operator: 1 }, false)];
    expect(evaluateRules(rules, { x: 1 }, { includeDisabled: false })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('evaluateRules — error propagation', () => {
  it('throws when a matching rule contains a malformed $expr', () => {
    const rules = [makeRule('broken', { $expr: '(' })];
    expect(() => evaluateRules(rules, {})).toThrow();
  });

  it('does not throw for disabled rules with malformed $expr when includeDisabled is false', () => {
    // Disabled rules are skipped before evaluation → no throw
    const rules = [makeRule('broken-disabled', { $expr: '(' }, false)];
    expect(() => evaluateRules(rules, {})).not.toThrow();
  });

  it('throws for disabled rules with malformed $expr when includeDisabled is true', () => {
    const rules = [makeRule('broken-disabled', { $expr: '(' }, false)];
    expect(() => evaluateRules(rules, {}, { includeDisabled: true })).toThrow();
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
    const [matched] = evaluateRules([rule], { env: 'prod' });
    expect(matched?.action).toEqual({ code: 200, tags: ['a', 'b'] });
  });
});
