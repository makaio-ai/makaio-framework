import { describe, expect, it } from 'vitest';
import {
  ConditionSchema,
  type LookupCall,
  LookupCallSchema,
  ParamTreeSchema,
  ReactionRuleSchema,
} from '../../index.js';

const lookup = { name: 'matches', lookup: 'inventory.list', args: {} };

describe('LookupCallSchema', () => {
  it('accepts reference operands in nested lookup conditions', () => {
    const input = {
      ...lookup,
      where: {
        $and: [
          { field: 'score', operator: { $gt: { ref: '$lookup.limit' } } },
          { $not: { field: 'tags', operator: { $in: { ref: '$event.facts.ignoredTags' } } } },
          { field: 'active', operator: true },
        ],
      },
    } satisfies LookupCall;

    expect(LookupCallSchema.parse(input)).toEqual(input);
    expect(ConditionSchema.safeParse(input.where).success).toBe(false);
  });

  it.each([
    { $eq: { ref: '$event.facts.expected' } },
    { $startsWith: { template: '{{ $event.facts.prefix }}-' } },
    { $eq: { literal: { ref: '$event.facts.expected' } } },
    { $ne: { literal: { literal: 'fixed' } } },
    { $eq: { ref: 3, label: 'direct' } },
    { $gt: 3 },
    { $exists: { literal: false } },
  ])('preserves the operand in %j for binding', (operator) => {
    const input = { ...lookup, where: { field: 'value', operator } };
    expect(LookupCallSchema.parse(input)).toEqual(input);
  });

  it.each([
    { $gt: { ref: '' } },
    { $eq: { ref: '' } },
    { $ne: { ref: 3 } },
    { $eq: { literal: undefined } },
    { $gt: { ref: '$event.facts.expected', literal: 3 } },
    { $eq: { ref: '$event.facts.expected' }, $gt: 3 },
  ])('rejects invalid operand forms in %j', (operator) => {
    expect(LookupCallSchema.safeParse({ ...lookup, where: { field: 'value', operator } }).success).toBe(false);
  });

  it.each([
    { ref: 3 },
    { template: 3 },
    { literal: undefined },
  ])('rejects malformed reserved operand %j in both positions', (operand) => {
    const where = { field: 'value', operator: { $eq: operand } };
    expect.soft(ParamTreeSchema.safeParse({ nested: [operand] }).success).toBe(false);
    expect(LookupCallSchema.safeParse({ ...lookup, where }).success).toBe(false);
  });

  it.each([
    { ref: 3 },
    { template: 3 },
    { literal: 3 },
  ])('preserves escaped reserved operand %j as data in both positions', (value) => {
    const literal = { literal: value };
    const input = { ...lookup, args: { value: literal }, where: { field: 'value', operator: { $eq: literal } } };
    expect(LookupCallSchema.parse(input)).toEqual(input);
  });

  it('keeps reserved lookup shapes literal in rule conditions', () => {
    const when = { field: '$event.facts.value', operator: { $eq: { ref: '' } } };
    const rule = {
      id: 'check',
      description: 'Check a fixed object',
      on: { kind: 'inventory.changed' },
      when,
      reaction: { kind: 'inventory.notify' },
    };
    expect(ReactionRuleSchema.parse(rule).when).toEqual(when);
  });
});
