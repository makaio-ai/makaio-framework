import { expect, it } from 'vitest';
import { EvaluationSettledSchema } from '../evaluation-settled.js';

const payload = {
  evaluationId: 'evaluation',
  ruleId: 'rule',
  cause: { message: { receivedAt: '2026-01-01T00:00:00Z' } },
  group: 'group',
  reason: 'settled',
};
const stoppedBy = { ruleIds: ['stopper'], reach: 'group' };

it('allows stopped events with or without stopper details', () => {
  const stopped = { ...payload, state: 'stopped' };
  expect(EvaluationSettledSchema.parse({ ...stopped, stoppedBy })).toEqual({ ...stopped, stoppedBy });
  expect(EvaluationSettledSchema.parse(stopped)).toEqual(stopped);
});

it.each(['not-matched', 'accepted', 'rejected', 'failed'])('rejects stopper details for %s events', (state) => {
  const settled = { ...payload, state };
  expect(EvaluationSettledSchema.parse(settled)).toEqual(settled);
  expect(EvaluationSettledSchema.safeParse({ ...settled, stoppedBy }).success).toBe(false);
});
