import { describe, expectTypeOf, it } from 'vitest';
import type { RuleId } from '../../rules/identifiers.js';
import type { ReactionCause, ReactionExecutionContext, ReactionInvocationId } from '../execution.js';

describe('ReactionCause', () => {
  it('carries the rule, evaluation, occasion, and rule set that caused an invocation', () => {
    expectTypeOf<ReactionCause>().toMatchTypeOf<{
      readonly ruleId: RuleId;
      readonly evaluationId: string;
      readonly event: unknown;
      readonly ruleSet: { readonly id: string; readonly digest: string };
      readonly rule: unknown;
    }>();
  });
});

describe('ReactionExecutionContext', () => {
  it('exposes exactly the runtime-controlled fields a handler may read', () => {
    expectTypeOf<ReactionExecutionContext>().toEqualTypeOf<{
      readonly invocationId: ReactionInvocationId;
      readonly correlationId: string | undefined;
      readonly signal: AbortSignal;
      readonly deadlineEpochMs: number | undefined;
      readonly key: string;
      readonly cause: ReactionCause;
    }>();
  });
});
