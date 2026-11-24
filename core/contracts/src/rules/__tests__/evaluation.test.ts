import { expect, it } from 'vitest';
import {
  RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT,
  RULES_EVALUATIONS_PAGE_MAX_LIMIT,
  RulesEvaluationsRequestSchema,
} from '../index.js';

it('defaults omitted page limits and preserves valid explicit limits', () => {
  expect(RulesEvaluationsRequestSchema.parse({ ruleId: 'rule-1' })).toEqual({
    ruleId: 'rule-1',
    limit: RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT,
  });
  expect(RulesEvaluationsRequestSchema.parse({ ruleId: 'rule-1', limit: 1 })).toEqual({
    ruleId: 'rule-1',
    limit: 1,
  });
  expect(
    RulesEvaluationsRequestSchema.safeParse({ ruleId: 'rule-1', limit: RULES_EVALUATIONS_PAGE_MAX_LIMIT + 1 }).success,
  ).toBe(false);
});
