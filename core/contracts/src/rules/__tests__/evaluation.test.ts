import { expect, it } from 'vitest';
import {
  EvaluationStateSchema,
  EvaluationViewSchema,
  RULES_EVALUATIONS_PAGE_DEFAULT_LIMIT,
  RULES_EVALUATIONS_PAGE_MAX_LIMIT,
  RulesEvaluationsRequestSchema,
} from '../index.js';

const view = {
  evaluationId: 'evaluation',
  ruleId: 'rule',
  ruleSet: { id: 'rules', digest: 'version' },
  event: {
    cause: { entryId: 'entry', position: 1 },
    subject: 'example.changed',
    origin: { caller: { kind: 'test.source', id: 'source' }, principal: { kind: 'test.person', id: 'owner' } },
    facts: {},
  },
  retries: 0,
  parts: [],
};
const stoppedBy = { ruleIds: ['stopper'], reach: 'group' };

it('allows stopped views with or without stopper details', () => {
  const stopped = { ...view, state: 'stopped' };
  expect(EvaluationViewSchema.parse({ ...stopped, stoppedBy })).toEqual({ ...stopped, stoppedBy });
  expect(EvaluationViewSchema.parse(stopped)).toEqual(stopped);
});

it.each(EvaluationStateSchema.exclude(['stopped']).options)('rejects stopper details for %s views', (state) => {
  const evaluation = { ...view, state };
  expect(EvaluationViewSchema.parse(evaluation)).toEqual(evaluation);
  expect(EvaluationViewSchema.safeParse({ ...evaluation, stoppedBy }).success).toBe(false);
});

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
