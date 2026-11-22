import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../index.js';
import { EvaluationIdSchema, RuleIdSchema } from '../identifiers.js';
import * as rulesBarrel from '../index.js';

describe('rule identifiers', () => {
  it('refuses an empty identifier and anything that is not a string', () => {
    expect(RuleIdSchema.safeParse('').success).toBe(false);
    expect(EvaluationIdSchema.safeParse('').success).toBe(false);
    expect(RuleIdSchema.safeParse(1).success).toBe(false);
    expect(EvaluationIdSchema.safeParse(null).success).toBe(false);
  });

  it('returns a valid identifier unchanged', () => {
    expect(RuleIdSchema.parse('rule-1')).toBe('rule-1');
    expect(EvaluationIdSchema.parse('evaluation-1')).toBe('evaluation-1');
  });

  it('is exported as the same schemas from the rules entry and the package root', () => {
    expect(rulesBarrel.RuleIdSchema).toBe(RuleIdSchema);
    expect(rulesBarrel.EvaluationIdSchema).toBe(EvaluationIdSchema);
    expect(rootBarrel.RuleIdSchema).toBe(RuleIdSchema);
    expect(rootBarrel.EvaluationIdSchema).toBe(EvaluationIdSchema);
  });
});
