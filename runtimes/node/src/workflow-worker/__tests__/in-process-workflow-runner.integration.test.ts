import { describe, expect, it } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import { WorkflowSubjects } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { InProcessWorkflowRunner } from '../in-process-workflow-runner.js';
import { makeBusWithStorage } from './fixtures.js';

/**
 * Build a minimal {@link WorkflowWorkerConfig} for in-process runner tests.
 * @param overrides - Optional config overrides.
 * @returns Valid worker config stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-runner-001' },
    executionId: 'exec-runner-001',
    workflowId: 'wf-runner-001',
    definition: {
      id: 'wf-runner-001',
      name: 'In-Process Runner Test',
      root: { id: 'wf-runner-001__root', type: 'sequence', nodes: [] },
      triggers: [],
      scope: { type: 'global' },
    },
    triggerPayload: { event: 'manual' },
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-runner-001',
    cancelSubject: 'workflow.cancel.wf-runner-001',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

describe('InProcessWorkflowRunner integration', () => {
  it('loads and executes a definition-sourced workflow through the real orchestrator', async () => {
    const [bus, cleanup, executions] = makeBusWithStorage();
    const completedEvents: Array<ExtractSubjectPayload<typeof WorkflowSubjects.execution.completed>> = [];
    const offCompleted = bus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completedEvents.push(ctx.payload);
    });

    try {
      const runner = new InProcessWorkflowRunner({ bus });
      const result = await runner.run(makeConfig(), new AbortController().signal);

      expect(result).toEqual({
        state: 'uncommitted',
        result: {
          executionId: 'exec-runner-001',
          workflowId: 'wf-runner-001',
          status: 'completed',
        },
      });
      expect(executions.get('exec-runner-001')?.status).toBe('completed');
      expect(completedEvents).toEqual([
        {
          executionId: 'exec-runner-001',
          workflowId: 'wf-runner-001',
          totalDuration: expect.any(Number),
          completedAt: expect.any(Number),
        },
      ]);
    } finally {
      offCompleted();
      cleanup();
    }
  });
});
