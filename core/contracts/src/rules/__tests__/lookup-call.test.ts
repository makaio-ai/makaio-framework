import { describe, expect, it } from 'vitest';
import { ConditionSchema, type LookupCall, LookupCallSchema } from '../../index.js';

describe('LookupCallSchema', () => {
  it('accepts reference operands in nested lookup conditions', () => {
    const lookup = {
      name: 'matches',
      lookup: 'inventory.list',
      args: {},
      where: {
        $and: [
          { field: 'score', operator: { $gt: { ref: '$lookup.limit' } } },
          { $not: { field: 'tags', operator: { $in: { ref: '$event.facts.ignoredTags' } } } },
          { field: 'active', operator: true },
        ],
      },
    } satisfies LookupCall;

    expect(LookupCallSchema.parse(lookup)).toEqual(lookup);
    expect(ConditionSchema.safeParse(lookup.where).success).toBe(false);
  });

  it('rejects malformed reference operands for ordered comparisons', () => {
    const lookup = {
      name: 'matches',
      lookup: 'inventory.list',
      args: {},
      where: { field: 'score', operator: { $gt: { ref: '' } } },
    };

    expect(LookupCallSchema.safeParse(lookup).success).toBe(false);
  });
});
