import { describe, expect, expectTypeOf, it } from 'vitest';
import { createReactionRuleRef } from '../execution.js';
import type { ReactionRuleRef } from '../execution.js';

describe('createReactionRuleRef', () => {
  it('brands primitive references without changing their values', () => {
    const stringRef = createReactionRuleRef('rule-7');
    const numberRef = createReactionRuleRef(42);

    expect(stringRef).toBe('rule-7');
    expect(numberRef).toBe(42);
    expectTypeOf(stringRef).toEqualTypeOf<'rule-7' & ReactionRuleRef>();
    expectTypeOf(numberRef).toEqualTypeOf<42 & ReactionRuleRef>();
  });

  it('brands object references without changing their identity', () => {
    const hostRef = { ruleId: 'rule-7' };
    const ruleRef = createReactionRuleRef(hostRef);

    expect(ruleRef).toBe(hostRef);
    expectTypeOf(ruleRef).toEqualTypeOf<typeof hostRef & ReactionRuleRef>();
  });

  it('keeps unbranded values out of the opaque rule-reference contract', () => {
    expectTypeOf<string>().not.toMatchTypeOf<ReactionRuleRef>();
    expectTypeOf<number>().not.toMatchTypeOf<ReactionRuleRef>();
  });
});
