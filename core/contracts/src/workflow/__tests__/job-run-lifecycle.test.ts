import { describe, expect, it } from 'vitest';
import * as rootBarrel from '../../index.js';
import * as workflowBarrel from '../index.js';
import { JobRunLifecycleStateSchema } from '../job-run-lifecycle.js';

describe('job run life cycle', () => {
  it('has exactly the five states', () => {
    expect(JobRunLifecycleStateSchema.options).toEqual(['ordered', 'running', 'completed', 'lost', 'cancelled']);
  });

  it('parses every state', () => {
    for (const state of JobRunLifecycleStateSchema.options) {
      expect(JobRunLifecycleStateSchema.parse(state)).toBe(state);
    }
  });

  it('does not take a workflow outcome for a state', () => {
    expect(JobRunLifecycleStateSchema.safeParse('failed').success).toBe(false);
  });

  it('is exported as the same schema from the workflow entry and the package root', () => {
    expect(workflowBarrel.JobRunLifecycleStateSchema).toBe(JobRunLifecycleStateSchema);
    expect(rootBarrel.JobRunLifecycleStateSchema).toBe(JobRunLifecycleStateSchema);
  });

  it('is reachable through the package specifier', async () => {
    const contracts = await import('@makaio/contracts');
    expect(contracts.JobRunLifecycleStateSchema.parse('lost')).toBe('lost');
  });
});
