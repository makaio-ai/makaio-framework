import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../index.js';
import { JobRunIdSchema, StepIdSchema } from '../identifiers.js';
import * as workflowBarrel from '../index.js';

describe('workflow identifiers', () => {
  it('refuses an empty identifier', () => {
    expect(JobRunIdSchema.safeParse('').success).toBe(false);
    expect(StepIdSchema.safeParse('').success).toBe(false);
    expect(JobRunIdSchema.parse('run-1')).toBe('run-1');
    expect(StepIdSchema.parse('step-1')).toBe('step-1');
  });

  it('is exported as the same schemas from the workflow entry and the package root', () => {
    expect(workflowBarrel.JobRunIdSchema).toBe(JobRunIdSchema);
    expect(workflowBarrel.StepIdSchema).toBe(StepIdSchema);
    expect(rootBarrel.JobRunIdSchema).toBe(JobRunIdSchema);
    expect(rootBarrel.StepIdSchema).toBe(StepIdSchema);
  });

  it('is reachable through the package specifier', async () => {
    const contracts = await import('@makaio/contracts');
    expect(contracts.JobRunIdSchema.parse('run-1')).toBe('run-1');
    expect(contracts.StepIdSchema.parse('step-1')).toBe('step-1');
  });
});
