import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import type { IWorkflowRunner, WorkflowRunnerCompletion } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('WorkflowExecutor cancellation', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    // Re-initialize for each test because the runner is injected per-test.
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  it.each([
    'completed',
    'failed',
  ] as const)('does not let a resolved %s runner overwrite concurrent cancellation', async (terminalStatus) => {
    const workflowId = `wf-cancel-${terminalStatus}-race-${Math.random().toString(36).slice(2)}`;
    const definition = createWorkflowDefinition({ id: workflowId });
    const releaseRunner = Promise.withResolvers<WorkflowRunnerCompletion>();
    const cancellationPersisted = Promise.withResolvers<void>();
    const releaseCancellationPublication = Promise.withResolvers<void>();
    const stubRunner: IWorkflowRunner = { run: vi.fn(() => releaseRunner.promise) };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.set, { workflow: definition });
    const holdCancelledEvent = MakaioBus.on(WorkflowSubjects.execution.cancelled, async () => {
      cancellationPersisted.resolve();
      await releaseCancellationPublication.promise;
    });

    try {
      const { executionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, { workflowId });
      const cancellation = MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, {
        executionId,
        reason: 'race winner',
      });
      await cancellationPersisted.promise;
      releaseRunner.resolve({
        state: 'uncommitted',
        result:
          terminalStatus === 'completed'
            ? { executionId, workflowId, status: 'completed' }
            : { executionId, workflowId, status: 'failed', error: 'late runner failure' },
      });
      releaseCancellationPublication.resolve();
      await expect(cancellation).resolves.toEqual({ cancelled: true });
      // Drain the launched task so the read observes state after the late runner result.
      await setup.workflowExecutor.destroy();
      expect(stubRunner.run).toHaveBeenCalledOnce();

      const { execution } = await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, {
        executionId,
      });
      expect(execution?.status).toBe('cancelled');
    } finally {
      releaseCancellationPublication.resolve();
      holdCancelledEvent();
    }
  });

  it('returns false when cancelling an unknown execution', async () => {
    setup = await setupWorkflowExecutorTest();

    const cancelResult = await MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, {
      executionId: 'missing-execution',
      reason: 'not running',
    });

    expect(cancelResult).toEqual({ cancelled: false });
  });
});
