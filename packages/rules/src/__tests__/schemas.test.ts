import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConditionSchema,
  ExpressionConditionSchema,
  FieldConditionSchema,
  FieldOperatorSchema,
  JsonObjectSchema,
  JsonValueSchema,
  RuleSchema,
  RuleSetOptionsSchema,
  ScalarValueSchema,
  type Condition,
  type Rule,
} from '../index.js';

// ---------------------------------------------------------------------------
// ScalarValueSchema
// ---------------------------------------------------------------------------

describe('ScalarValueSchema', () => {
  it('accepts a string', () => {
    expect(ScalarValueSchema.parse('hello')).toBe('hello');
  });

  it('accepts a finite number', () => {
    expect(ScalarValueSchema.parse(3.14)).toBe(3.14);
  });

  it('accepts a boolean', () => {
    expect(ScalarValueSchema.parse(true)).toBe(true);
  });

  it('accepts null', () => {
    expect(ScalarValueSchema.parse(null)).toBeNull();
  });

  it('rejects Infinity', () => {
    expect(ScalarValueSchema.safeParse(Infinity).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(ScalarValueSchema.safeParse(NaN).success).toBe(false);
  });

  it('rejects an object', () => {
    expect(ScalarValueSchema.safeParse({ key: 'val' }).success).toBe(false);
  });

  it('rejects an array', () => {
    expect(ScalarValueSchema.safeParse(['a']).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JsonValueSchema
// ---------------------------------------------------------------------------

describe('JsonValueSchema', () => {
  it('accepts a string', () => {
    expect(JsonValueSchema.parse('text')).toBe('text');
  });

  it('accepts a finite number', () => {
    expect(JsonValueSchema.parse(1.5)).toBe(1.5);
  });

  it('accepts a boolean', () => {
    expect(JsonValueSchema.parse(false)).toBe(false);
  });

  it('accepts null', () => {
    expect(JsonValueSchema.parse(null)).toBeNull();
  });

  it('accepts a nested object', () => {
    const val = { a: { b: [1, 2, null] } };
    expect(JsonValueSchema.parse(val)).toEqual(val);
  });

  it('accepts an array of mixed JSON values', () => {
    expect(JsonValueSchema.parse([1, 'two', true, null])).toEqual([1, 'two', true, null]);
  });

  it('rejects Infinity', () => {
    expect(JsonValueSchema.safeParse(Infinity).success).toBe(false);
  });

  it('rejects -Infinity', () => {
    expect(JsonValueSchema.safeParse(-Infinity).success).toBe(false);
  });

  it('rejects NaN', () => {
    expect(JsonValueSchema.safeParse(NaN).success).toBe(false);
  });

  it('rejects Infinity nested inside an object', () => {
    expect(JsonValueSchema.safeParse({ nested: [1, Infinity] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JsonObjectSchema
// ---------------------------------------------------------------------------

describe('JsonObjectSchema', () => {
  it('accepts a flat object', () => {
    expect(JsonObjectSchema.parse({ a: 1, b: 'text' })).toEqual({ a: 1, b: 'text' });
  });

  it('accepts an object with null values', () => {
    expect(JsonObjectSchema.parse({ x: null })).toEqual({ x: null });
  });

  it('rejects a non-object', () => {
    expect(JsonObjectSchema.safeParse('string').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FieldOperatorSchema
// ---------------------------------------------------------------------------

describe('FieldOperatorSchema', () => {
  it('accepts a bare string as implicit $eq', () => {
    expect(FieldOperatorSchema.parse('active')).toBe('active');
  });

  it('accepts a bare number', () => {
    expect(FieldOperatorSchema.parse(42)).toBe(42);
  });

  it('accepts a bare null', () => {
    expect(FieldOperatorSchema.parse(null)).toBeNull();
  });

  it('accepts explicit $eq', () => {
    expect(FieldOperatorSchema.parse({ $eq: 'prod' })).toEqual({ $eq: 'prod' });
  });

  it('accepts explicit $ne', () => {
    expect(FieldOperatorSchema.parse({ $ne: 'dev' })).toEqual({ $ne: 'dev' });
  });

  it('accepts $in with values', () => {
    expect(FieldOperatorSchema.parse({ $in: ['a', 'b'] })).toEqual({ $in: ['a', 'b'] });
  });

  it('accepts $in with empty array', () => {
    expect(FieldOperatorSchema.parse({ $in: [] })).toEqual({ $in: [] });
  });

  it('accepts $nin', () => {
    expect(FieldOperatorSchema.parse({ $nin: [1, 2] })).toEqual({ $nin: [1, 2] });
  });

  it('accepts $contains', () => {
    expect(FieldOperatorSchema.parse({ $contains: 'member' })).toEqual({ $contains: 'member' });
  });

  it('accepts $containsPrefix', () => {
    expect(FieldOperatorSchema.parse({ $containsPrefix: 'repo:' })).toEqual({
      $containsPrefix: 'repo:',
    });
  });

  it('accepts $exists: true', () => {
    expect(FieldOperatorSchema.parse({ $exists: true })).toEqual({ $exists: true });
  });

  it('accepts $exists: false', () => {
    expect(FieldOperatorSchema.parse({ $exists: false })).toEqual({ $exists: false });
  });

  it('accepts $startsWith', () => {
    expect(FieldOperatorSchema.parse({ $startsWith: '.git/' })).toEqual({ $startsWith: '.git/' });
  });

  it('accepts $endsWith', () => {
    expect(FieldOperatorSchema.parse({ $endsWith: '.ts' })).toEqual({ $endsWith: '.ts' });
  });

  it('accepts $glob', () => {
    expect(FieldOperatorSchema.parse({ $glob: '**/*.ts' })).toEqual({ $glob: '**/*.ts' });
  });

  it('rejects an object combining two operators (strict mode)', () => {
    expect(FieldOperatorSchema.safeParse({ $eq: 'a', $ne: 'b' }).success).toBe(false);
  });

  it('rejects unknown operator keys via strict mode', () => {
    expect(FieldOperatorSchema.safeParse({ $unknown: 'val' }).success).toBe(false);
  });

  it('rejects $exists with a non-boolean value', () => {
    expect(FieldOperatorSchema.safeParse({ $exists: 'yes' }).success).toBe(false);
  });

  it('rejects $in with a non-scalar element (object in array)', () => {
    expect(FieldOperatorSchema.safeParse({ $in: [{ nested: 1 }] }).success).toBe(false);
  });

  it('rejects $contains with a non-scalar value', () => {
    expect(FieldOperatorSchema.safeParse({ $contains: ['member'] }).success).toBe(false);
  });

  it('rejects $containsPrefix with a non-string value', () => {
    expect(FieldOperatorSchema.safeParse({ $containsPrefix: 42 }).success).toBe(false);
  });

  it('rejects $containsPrefix combined with another operator (strict mode)', () => {
    expect(FieldOperatorSchema.safeParse({ $containsPrefix: 'repo:', $eq: 'a' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FieldConditionSchema
// ---------------------------------------------------------------------------

describe('FieldConditionSchema', () => {
  it('accepts a valid field condition', () => {
    expect(FieldConditionSchema.parse({ field: 'env', operator: 'prod' })).toEqual({
      field: 'env',
      operator: 'prod',
    });
  });

  it('rejects an empty field name', () => {
    expect(FieldConditionSchema.safeParse({ field: '', operator: 'prod' }).success).toBe(false);
  });

  it('rejects a missing operator', () => {
    expect(FieldConditionSchema.safeParse({ field: 'env' }).success).toBe(false);
  });

  it('rejects extra unknown keys (strict mode)', () => {
    expect(FieldConditionSchema.safeParse({ field: 'env', operator: 'prod', extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExpressionConditionSchema
// ---------------------------------------------------------------------------

describe('ExpressionConditionSchema', () => {
  it('accepts a valid $expr string', () => {
    expect(ExpressionConditionSchema.parse({ $expr: 'score > 5' })).toEqual({ $expr: 'score > 5' });
  });

  it('rejects an empty $expr string', () => {
    expect(ExpressionConditionSchema.safeParse({ $expr: '' }).success).toBe(false);
  });

  it('rejects extra keys alongside $expr', () => {
    expect(ExpressionConditionSchema.safeParse({ $expr: 'x > 0', extra: true }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConditionSchema — valid shapes
// ---------------------------------------------------------------------------

describe('ConditionSchema — valid shapes', () => {
  it('accepts a field condition', () => {
    const cond: Condition = { field: 'status', operator: 'active' };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('accepts an $and condition with one child', () => {
    const cond: Condition = { $and: [{ field: 'x', operator: 1 }] };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('accepts an $or condition with multiple children', () => {
    const cond: Condition = {
      $or: [
        { field: 'a', operator: 'x' },
        { field: 'b', operator: 'y' },
      ],
    };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('accepts a $not condition', () => {
    const cond: Condition = { $not: { field: 'disabled', operator: true } };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('accepts a $expr condition', () => {
    const cond: Condition = { $expr: 'count > 0' };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('accepts a nested compound condition', () => {
    const cond: Condition = {
      $and: [
        { field: 'env', operator: 'prod' },
        { $or: [{ field: 'branch', operator: 'main' }, { $expr: 'hotfix == true' }] },
      ],
    };
    expect(ConditionSchema.parse(cond)).toEqual(cond);
  });

  it('round-trips a condition through JSON serialization', () => {
    const cond: Condition = {
      $and: [{ field: 'env', operator: { $in: ['prod', 'staging'] } }, { $not: { field: 'disabled', operator: true } }],
    };
    const roundTripped = ConditionSchema.parse(JSON.parse(JSON.stringify(cond)));
    expect(roundTripped).toEqual(cond);
  });
});

// ---------------------------------------------------------------------------
// ConditionSchema — invalid shapes
// ---------------------------------------------------------------------------

describe('ConditionSchema — invalid shapes', () => {
  it('rejects an $and with empty array', () => {
    expect(ConditionSchema.safeParse({ $and: [] }).success).toBe(false);
  });

  it('rejects an $or with empty array', () => {
    expect(ConditionSchema.safeParse({ $or: [] }).success).toBe(false);
  });

  it('rejects a completely unknown shape', () => {
    expect(ConditionSchema.safeParse({ unknown: 'value' }).success).toBe(false);
  });

  it('rejects a field condition with an empty field name', () => {
    expect(ConditionSchema.safeParse({ field: '', operator: 'x' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RuleSetOptionsSchema
// ---------------------------------------------------------------------------

describe('RuleSetOptionsSchema', () => {
  it('accepts an empty options object', () => {
    expect(RuleSetOptionsSchema.parse({})).toEqual({});
  });

  it('accepts includeDisabled: true', () => {
    expect(RuleSetOptionsSchema.parse({ includeDisabled: true })).toEqual({
      includeDisabled: true,
    });
  });

  it('accepts includeDisabled: false', () => {
    expect(RuleSetOptionsSchema.parse({ includeDisabled: false })).toEqual({
      includeDisabled: false,
    });
  });

  it('rejects extra unknown keys (strict mode)', () => {
    expect(RuleSetOptionsSchema.safeParse({ includeDisabled: true, extra: 1 }).success).toBe(false);
  });

  it('rejects non-boolean includeDisabled', () => {
    expect(RuleSetOptionsSchema.safeParse({ includeDisabled: 'yes' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RuleSchema factory
// ---------------------------------------------------------------------------

describe('RuleSchema factory', () => {
  const actionSchema = z.object({ label: z.string() });

  it('parses a minimal valid rule', () => {
    const rule = {
      id: 'r1',
      name: 'Rule 1',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'inject' },
      priority: 0,
      enabled: true,
    };
    expect(RuleSchema(actionSchema).parse(rule)).toEqual(rule);
  });

  it('parses a rule with optional description and metadata', () => {
    const rule = {
      id: 'r2',
      name: 'Rule 2',
      description: 'desc',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'tag' },
      priority: 5,
      enabled: false,
      metadata: { source: 'unit-test', count: 1, flag: null },
    };
    expect(RuleSchema(actionSchema).parse(rule)).toEqual(rule);
  });

  it('rejects a rule with empty id', () => {
    const rule = {
      id: '',
      name: 'Rule',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'x' },
      priority: 0,
      enabled: true,
    };
    expect(RuleSchema(actionSchema).safeParse(rule).success).toBe(false);
  });

  it('rejects a rule with empty name', () => {
    const rule = {
      id: 'r',
      name: '',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'x' },
      priority: 0,
      enabled: true,
    };
    expect(RuleSchema(actionSchema).safeParse(rule).success).toBe(false);
  });

  it('rejects Infinity as priority', () => {
    const rule = {
      id: 'r',
      name: 'Rule',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'x' },
      priority: Infinity,
      enabled: true,
    };
    expect(RuleSchema(actionSchema).safeParse(rule).success).toBe(false);
  });

  it('rejects -Infinity as priority', () => {
    const rule = {
      id: 'r',
      name: 'Rule',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'x' },
      priority: -Infinity,
      enabled: true,
    };
    expect(RuleSchema(actionSchema).safeParse(rule).success).toBe(false);
  });

  it('enforces the caller-provided action schema', () => {
    const strictAction = z.object({ code: z.number() });
    const rule = {
      id: 'r',
      name: 'Rule',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'wrong-type' }, // does not match strictAction
      priority: 0,
      enabled: true,
    };
    expect(RuleSchema(strictAction).safeParse(rule).success).toBe(false);
  });

  it('rejects extra top-level keys (strict mode)', () => {
    const rule = {
      id: 'r',
      name: 'Rule',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'x' },
      priority: 0,
      enabled: true,
      unknownField: 'not-allowed',
    };
    expect(RuleSchema(actionSchema).safeParse(rule).success).toBe(false);
  });

  it('round-trips a complex rule through JSON serialization', () => {
    const taggedAction = z.object({ label: z.string(), tags: z.array(z.string()) });
    const rule: Rule<{ label: string; tags: string[] }> = {
      id: 'rule-complex',
      name: 'Complex Rule',
      description: 'Serialization round-trip test',
      condition: {
        $and: [{ field: 'env', operator: 'prod' }, { $not: { field: 'branch', operator: { $eq: 'develop' } } }],
      },
      action: { label: 'deploy', tags: ['infra', 'prod'] },
      priority: 10,
      enabled: true,
      metadata: { audience: 'backend', count: 3, optional: null },
    };

    const parsed = RuleSchema(taggedAction).parse(JSON.parse(JSON.stringify(rule)));
    expect(parsed).toEqual(rule);
  });
});
