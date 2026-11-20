import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { matchesFilter } from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { ConditionSchema, JsonValueSchema, RuleSchema, evaluateRules, type Condition, type Rule } from '../index.js';
import { errorOf, makeRule, matched } from './support.js';

describe('@makaio/rules evaluate', () => {
  it('supports implicit equality and strict scalar comparison', () => {
    expect(matched({ field: 'count', operator: 2 }, { count: 2 })).toBe(true);
    expect(matched({ field: 'count', operator: 2 }, { count: '2' })).toBe(false);
    expect(matched({ field: 'value', operator: { $eq: null } }, { value: null })).toBe(true);
  });

  it('supports compatibility-sensitive payload operators', () => {
    const context = {
      status: 'active',
      kind: 'user',
      value: null,
      path: 'src/rules/index.ts',
      ref: '.git/refs/heads/main',
    };

    expect(matched({ field: 'status', operator: { $in: ['active', 'pending'] } }, context)).toBe(true);
    expect(matched({ field: 'kind', operator: { $nin: ['system', 'internal'] } }, context)).toBe(true);
    expect(matched({ field: 'kind', operator: { $ne: 'system' } }, context)).toBe(true);
    expect(matched({ field: 'missing', operator: { $exists: false } }, context)).toBe(true);
    expect(matched({ field: 'value', operator: { $exists: true } }, context)).toBe(true);
    expect(matched({ field: 'ref', operator: { $startsWith: '.git/' } }, context)).toBe(true);
    expect(matched({ field: 'path', operator: { $endsWith: '.ts' } }, context)).toBe(true);
    expect(matched({ field: 'path', operator: { $glob: '**/*.ts' } }, context)).toBe(true);
  });

  it('keeps string prefix and suffix operators string-only', () => {
    const context = { version: 1234 };

    expect(matched({ field: 'version', operator: { $startsWith: '12' } }, context)).toBe(false);
    expect(matched({ field: 'version', operator: { $endsWith: '34' } }, context)).toBe(false);
  });

  it('uses payload-filter-compatible dot-path traversal', () => {
    const context = {
      items: [{ name: 'alpha' }],
      nested: { state: 'ready' },
      primitive: 'leaf',
      nullable: null,
    };

    expect(matched({ field: 'items.0.name', operator: 'alpha' }, context)).toBe(true);
    expect(matched({ field: 'nested.state', operator: 'ready' }, context)).toBe(true);
    expect(matched({ field: 'primitive.value', operator: { $exists: false } }, context)).toBe(true);
    expect(matched({ field: 'nullable.value', operator: { $exists: false } }, context)).toBe(true);
  });

  it('supports compound conditions and expressions', () => {
    const context = { branch: 'main', cwd: '/repo/framework/packages/rules', score: 3 };

    const condition: Condition = {
      $and: [
        { field: 'cwd', operator: { $glob: '**/framework/packages/**' } },
        { $or: [{ field: 'branch', operator: 'main' }, { $expr: 'score > 10' }] },
        { $not: { field: 'score', operator: { $eq: 0 } } },
      ],
    };

    expect(matched(condition, context)).toBe(true);
  });

  it('returns an error outcome when an $expr is malformed', () => {
    const error = errorOf({ $expr: '(' }, { status: 'open' });

    expect(error.path).toBe('$expr');
    expect(error.message).not.toBe('');
  });

  it('evaluates all $and and $or operands so a malformed $expr is never hidden', () => {
    const andCondition: Condition = {
      $and: [{ field: 'status', operator: 'closed' }, { $expr: '(' }],
    };
    const orCondition: Condition = {
      $or: [{ field: 'status', operator: 'open' }, { $expr: '(' }],
    };

    const andError = errorOf(andCondition, { status: 'open' });
    const orError = errorOf(orCondition, { status: 'open' });

    expect(andError.path).toBe('$and[1].$expr');
    expect(andError.message).not.toBe('');
    expect(orError.path).toBe('$or[1].$expr');
    expect(orError.message).not.toBe('');
  });
});

describe('@makaio/rules evaluateRules', () => {
  it('preserves caller-provided order instead of interpreting priority metadata', () => {
    const rules = [
      makeRule('second', { field: 'env', operator: 'prod' }, true, 50),
      makeRule('disabled', { field: 'env', operator: 'prod' }, false, 1),
      makeRule('first', { field: 'env', operator: 'prod' }, true, 0),
    ];

    const matches = evaluateRules(rules, { env: 'prod' }).matched;

    expect(matches.map((rule) => rule.id)).toEqual(['second', 'first']);
  });

  it('can include disabled rules when requested', () => {
    const rules = [makeRule('disabled', { field: 'env', operator: 'prod' }, false)];

    const matches = evaluateRules(rules, { env: 'prod' }, { includeDisabled: true }).matched;

    expect(matches.map((rule) => rule.id)).toEqual(['disabled']);
  });

  it('reports a rule with a malformed $expr in failed instead of throwing', () => {
    const rules = [makeRule('broken', { $expr: '(' })];

    const outcome = evaluateRules(rules, { env: 'prod' });

    expect(outcome.matched).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.rule.id).toBe('broken');
    expect(outcome.failed[0]?.error.path).toBe('$expr');
    expect(outcome.failed[0]?.error.message).not.toBe('');
  });
});

describe('@makaio/rules schemas', () => {
  it('round-trips serialized conditions and rules without evaluation artifacts', () => {
    const actionSchema = z.object({
      label: z.string(),
      tags: z.array(z.string()),
    });
    const rule = {
      id: 'rule-1',
      name: 'Rule 1',
      description: 'test rule',
      condition: {
        $and: [{ field: 'env', operator: 'prod' }, { $not: { field: 'branch', operator: { $eq: 'develop' } } }],
      },
      action: {
        label: 'inject',
        tags: ['cli', 'rules'],
      },
      priority: 10,
      enabled: true,
      metadata: {
        audience: 'framework',
        count: 1,
        optional: null,
      },
    } satisfies Rule<{ label: string; tags: string[] }>;

    const serialized = JSON.stringify(rule);
    const parsedCondition = ConditionSchema.parse(JSON.parse(JSON.stringify(rule.condition)));
    const parsedRule = RuleSchema(actionSchema).parse(JSON.parse(serialized));

    expect(parsedCondition).toEqual(rule.condition);
    expect(parsedRule).toEqual(rule);

    evaluateRules([rule], { env: 'prod', branch: 'main' });

    expect(JSON.stringify(rule)).toBe(serialized);
  });

  it('rejects ambiguous operator objects', () => {
    const result = ConditionSchema.safeParse({
      field: 'env',
      operator: {
        $eq: 'prod',
        $ne: 'dev',
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects non-finite JSON numbers', () => {
    expect(JsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(JsonValueSchema.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
    expect(JsonValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: [1, Number.POSITIVE_INFINITY] }).success).toBe(false);
    expect(JsonValueSchema.safeParse(1.5).success).toBe(true);
  });

  it('accepts finite rule priorities and rejects non-finite ones explicitly', () => {
    const actionSchema = z.object({ label: z.string() });
    const validResult = RuleSchema(actionSchema).safeParse({
      id: 'rule-finite-priority',
      name: 'Finite Priority',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'inject' },
      priority: 10,
      enabled: true,
    });
    const result = RuleSchema(actionSchema).safeParse({
      id: 'rule-infinite-priority',
      name: 'Infinite Priority',
      condition: { field: 'env', operator: 'prod' },
      action: { label: 'inject' },
      priority: Number.POSITIVE_INFINITY,
      enabled: true,
    });

    expect(validResult.success).toBe(true);
    expect(result.success).toBe(false);
  });
});

describe('@makaio/rules compatibility', () => {
  it('matches overlapping payload-filter semantics from bus-core', () => {
    const context = {
      status: 'active',
      count: 2,
      path: '.git/refs/heads/main',
      file: 'src/index.ts',
      nested: { value: 'ready' },
      missing: undefined,
      version: 1234,
    };
    const cases: Array<{ condition: Condition; filter: PayloadFilter }> = [
      {
        condition: { field: 'status', operator: 'active' },
        filter: { status: 'active' },
      },
      {
        condition: { field: 'count', operator: { $ne: 1 } },
        filter: { count: { $ne: 1 } },
      },
      {
        condition: { field: 'status', operator: { $in: ['active', 'pending'] } },
        filter: { status: { $in: ['active', 'pending'] } },
      },
      {
        condition: { field: 'missing', operator: { $exists: false } },
        filter: { missing: { $exists: false } },
      },
      {
        condition: { field: 'path', operator: { $startsWith: '.git/' } },
        filter: { path: { $startsWith: '.git/' } },
      },
      {
        condition: { field: 'file', operator: { $endsWith: '.ts' } },
        filter: { file: { $endsWith: '.ts' } },
      },
      {
        condition: { field: 'nested.value', operator: 'ready' },
        filter: { 'nested.value': 'ready' },
      },
      {
        condition: { field: 'version', operator: { $startsWith: '12' } },
        filter: { version: { $startsWith: '12' } },
      },
    ];

    for (const testCase of cases) {
      expect(matched(testCase.condition, context)).toBe(matchesFilter(context, testCase.filter));
    }
  });
});
