import { expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import type { WorkflowRunAdmissionErrorCode } from '../index.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';
import { setupWorkflowExecutorTest, teardownWorkflowExecutorTest } from './workflow-executor.test-setup.js';

it('runs the host cancellation hook before changing the durable state and releases exact registrations', async () => {
  const setup = await setupWorkflowExecutorTest();
  const authority = setup.workflowExecutor;
  const call = createTestCall();
  const execution = createWorkflowExecution({ status: 'running' });
  const input = { executionId: execution.id, reason: 'requested' };
  const observed: Array<{ executionId: string; reason?: string; status: unknown }> = [];

  try {
    await MakaioBus.request(call, WorkflowStorageSubjects.setExecution, { execution });
    let refuse = true;
    const hook = async (hookCall: typeof call, executionId: string, reason?: string) => {
      const { execution: owner } = await MakaioBus.request(hookCall, WorkflowStorageSubjects.getExecution, {
        executionId,
      });
      observed.push({ executionId, reason, status: owner?.status });
      if (refuse) throw new Error('cancellation intent was not stored');
    };
    const dispose = authority.registerRunCancellationHook(hook);
    expect(() => authority.registerRunCancellationHook(hook)).toThrow('already registered');

    await expect(MakaioBus.request(call, WorkflowSubjects.cancel, input)).rejects.toThrow(
      'cancellation intent was not stored',
    );
    expect(
      (await MakaioBus.request(call, WorkflowStorageSubjects.getExecution, { executionId: execution.id })).execution
        ?.status,
    ).toBe('running');

    dispose();
    const disposeReplacement = authority.registerRunCancellationHook(hook);
    dispose();
    refuse = false;
    await expect(MakaioBus.request(call, WorkflowSubjects.cancel, input)).resolves.toEqual({ cancelled: true });
    disposeReplacement();
    expect(observed).toEqual([
      { ...input, status: 'running' },
      { ...input, status: 'running' },
    ]);
  } finally {
    await teardownWorkflowExecutorTest(setup);
  }
});

it('separates run cancellation from draining the runner', async () => {
  const entered = Promise.withResolvers<void>();
  const canFinish = Promise.withResolvers<void>();
  const setup = await setupWorkflowExecutorTest({
    workflowRunner: {
      async run(_call, config) {
        entered.resolve();
        await canFinish.promise;
        return {
          state: 'uncommitted',
          result: { executionId: config.executionId, workflowId: config.workflowId, status: 'cancelled' },
        };
      },
    },
  });
  const call = createTestCall();
  const workflow = createWorkflowDefinition();
  try {
    await MakaioBus.request(call, WorkflowStorageSubjects.set, { workflow });
    const { executionId } = await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: workflow.id });
    await entered.promise;
    await setup.workflowExecutor.cancelActiveRuns(call, 'host shutdown');
    const { execution } = await MakaioBus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution).toMatchObject({ status: 'cancelled', reason: 'host shutdown' });

    let settled = false;
    const drain = setup.workflowExecutor.settleRuns(call).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    canFinish.resolve();
    await drain;
    expect(settled).toBe(true);
  } finally {
    canFinish.resolve();
    await teardownWorkflowExecutorTest(setup);
  }
});

it('refuses runner admission with a typed error when the durable run stops without a local abort', async () => {
  const refusal = Promise.withResolvers<unknown>();
  let admitted = false;
  const setup = await setupWorkflowExecutorTest({
    workflowRunner: {
      async run(call, config, _signal, _manifest, options) {
        try {
          await MakaioBus.request(call, WorkflowStorageSubjects.updateExecution, {
            executionId: config.executionId,
            status: 'cancelled',
          });
          if (options?.withRunAdmission === undefined) throw new Error('Missing runner admission hook');
          await options.withRunAdmission(async () => {
            admitted = true;
          });
          refusal.resolve(undefined);
        } catch (error) {
          refusal.resolve(error);
        }
        return { state: 'authority-recorded-only', executionId: config.executionId, workflowId: config.workflowId };
      },
    },
  });
  const call = createTestCall();
  const workflow = createWorkflowDefinition();
  try {
    await MakaioBus.request(call, WorkflowStorageSubjects.set, { workflow });
    await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: workflow.id });
    const code: WorkflowRunAdmissionErrorCode = 'run-not-admissible';
    expect(await refusal.promise).toMatchObject({ code });
    expect(admitted).toBe(false);
  } finally {
    await teardownWorkflowExecutorTest(setup);
  }
});
