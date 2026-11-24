import { describe, expectTypeOf, it } from 'vitest';
import type { RightAnswer } from '../right.js';
import type { HandlerContext } from '../handler-context.js';

describe('HandlerContext method return types', () => {
  it('hasRight resolves to the combined RightAnswer', () => {
    expectTypeOf<ReturnType<HandlerContext['hasRight']>>().resolves.toEqualTypeOf<RightAnswer>();
  });
});
