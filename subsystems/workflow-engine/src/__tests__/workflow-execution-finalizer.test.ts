import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import { cancelExecution } from '../workflow-execution-finalizer.js';
import type { ActiveExecution } from '../types.js';
import type { WorkflowDefinition } from '@makaio/contracts';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

describe('cancelExecution', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
    vi.restoreAllMocks();
  });

  it('removes the active execution when cancellation event emission fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    MakaioBus.__resetHandlers?.();
    const cleanupFns: Array<() => void> = [];

    cleanupFns.push(
      MakaioBus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
        ctx.setResult({ id: ctx.payload.execution.id });
      }),
    );
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        throw new Error('cancelled event unavailable');
      }),
    );

    const workflow: WorkflowDefinition = {
      ...createWorkflowDefinition({
        steps: [{ id: 'plan', type: 'agent', prompt: 'Plan' }],
      }),
      createdAt: 0,
      updatedAt: 0,
    };
    const execution = createWorkflowExecution({
      id: 'execution-cancel-cleanup',
      workflowId: workflow.id,
      steps: { plan: { status: 'running' } },
    });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow,
          expandedSteps: workflow.steps,
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);

    try {
      await expect(
        cancelExecution(
          MakaioBus,
          activeExecutions,
          new Map(),
          new WorkflowGateCoordinator(MakaioBus),
          execution.id,
          'test cancellation',
        ),
      ).rejects.toThrow('cancelled event unavailable');

      expect(activeExecutions.has(execution.id)).toBe(false);
    } finally {
      cleanupFns.forEach((cleanup) => cleanup());
    }
  });
});
