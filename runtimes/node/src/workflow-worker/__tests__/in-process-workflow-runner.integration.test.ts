import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkflowExecution, WorkflowWorkerConfig } from '@makaio/contracts';
import { WorkflowNamespace, WorkflowSubjects } from '@makaio/contracts';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import type { ExtractSubjectPayload } from '@makaio/core';
import { InProcessWorkflowRunner } from '../in-process-workflow-runner.js';

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
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: {},
    coordinatorSessionId: 'session-runner-001',
    cancelSubject: 'workflow.cancel.wf-runner-001',
    ...overrides,
  };
}

/**
 * Register in-memory workflow storage handlers on a bus instance.
 *
 * Provides the minimum storage surface the orchestrator needs for a zero-step
 * workflow run, while still exercising the real storage request subjects.
 * @param bus - Bus instance to register handlers on.
 * @returns Cleanup function and execution store.
 */
function registerInMemoryStorage(
  bus: ReturnType<typeof createBusInstance>,
): [() => void, Map<string, WorkflowExecution>] {
  const executions = new Map<string, WorkflowExecution>();

  const offSet = bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id });
  });

  const offUpdate = bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const { executionId, status, error, completedAt } = ctx.payload;
    const execution = executions.get(executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (status !== undefined) execution.status = status;
    if (error !== undefined) execution.error = error ?? undefined;
    if (completedAt !== undefined) execution.completedAt = completedAt ?? undefined;
    ctx.setResult({ success: true });
  });

  const offSpan = bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    ctx.setResult({ id: ctx.payload.span.stepId });
  });

  return [
    () => {
      offSet();
      offUpdate();
      offSpan();
    },
    executions,
  ];
}

/**
 * Create an isolated bus with workflow namespaces and storage handlers.
 * @returns Bus, cleanup function, and execution store.
 */
function makeBusWithStorage(): [ReturnType<typeof createBusInstance>, () => void, Map<string, WorkflowExecution>] {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const [cleanup, executions] = registerInMemoryStorage(bus);
  return [bus, cleanup, executions];
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
        executionId: 'exec-runner-001',
        workflowId: 'wf-runner-001',
        status: 'completed',
      });
      expect(executions.get('exec-runner-001')?.status).toBe('completed');
      expect(completedEvents).toEqual([
        {
          executionId: 'exec-runner-001',
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
