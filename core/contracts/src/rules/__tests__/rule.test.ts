import { describe, expect, it } from 'vitest';
import { ReactionRuleSchema } from '../../index.js';

const rule = {
  id: 'notify',
  description: 'Notify on timer',
  on: { kind: 'alpha.timer' },
};

describe('ReactionRuleSchema', () => {
  it.each([
    { shape: 'scalar', params: 'hello' },
    { shape: 'array', params: ['hello'] },
  ])('rejects $shape reaction parameters', ({ params }) => {
    const result = ReactionRuleSchema.safeParse({ ...rule, reaction: { kind: 'alpha.notify', params } });

    expect(result.error?.issues[0]?.path).toEqual(['reaction', 'params']);
  });

  it('accepts an object of parameter trees', () => {
    const reaction = {
      kind: 'alpha.notify',
      params: { message: { ref: '$event.message' }, recipients: ['admin'] },
    };

    expect(ReactionRuleSchema.parse({ ...rule, reaction }).reaction).toEqual(reaction);
  });
});
