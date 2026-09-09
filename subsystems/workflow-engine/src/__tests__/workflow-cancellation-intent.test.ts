import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createWorkflowCancelSubject, type IWorkflowRunner, type WorkflowRunnerCompletion } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createInMemoryAttemptRepository, makeTestInstruction } from '../testing/index.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { cancelExecution } from '../workflow-execution-finalizer.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow durable cancellation intent', () => {
  let setup: WorkflowExecutorTestSetup | undefined;
  afterEach(async () => {
    if (setup !== undefined) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it.each(['running', 'paused'] as const)('commits %s owner intent before notifying a controller', async (status) => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution({ status });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    const delivered: unknown[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), async () => {
        delivered.push(await repository.readCancellation(attempt.executionAttemptId));
      }),
    );
    await expect(
      MakaioBus.request(WorkflowSubjects.cancel, { executionId: execution.id, reason: 'operator' }),
    ).resolves.toEqual({ cancelled: true });
    expect(delivered).toEqual([{ requestedAt: expect.any(String), reason: 'operator' }]);
    const replacement = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec, repository);
    expect(await replacement.readCancellation(attempt.executionAttemptId)).toEqual(delivered[0]);
    expect(repository.attempts.get(attempt.executionAttemptId)).toMatchObject({
      status: 'pending',
      settlementKind: null,
    });
  });

  it.each(['completed', 'finalizing'] as const)('does not deliver cancellation for a %s owner', async (status) => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution({ status });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    let notifications = 0;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), () => {
        notifications += 1;
      }),
    );
    await expect(MakaioBus.request(WorkflowSubjects.cancel, { executionId: execution.id })).resolves.toEqual({
      cancelled: false,
    });
    expect(await authority.readCancellation(attempt.executionAttemptId)).toBeNull();
    expect(notifications).toBe(0);
  });

  it('does not notify or terminalize the owner when cancellation persistence fails', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(
      {
        ...repository,
        async requestCancellation() {
          throw new Error('cancellation store unavailable');
        },
      },
      { bootstrapTimeoutMs: 60_000 },
    );
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    let notifications = 0;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), () => {
        notifications += 1;
      }),
    );
    await expect(MakaioBus.request(WorkflowSubjects.cancel, { executionId: execution.id })).rejects.toThrow(
      'cancellation store unavailable',
    );
    expect(notifications).toBe(0);
    expect(
      (await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id })).execution,
    ).toMatchObject({ status: 'running' });
  });

  it('converges an observed cancellation without creating another control request', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    let notifications = 0;
    expect(
      await cancelExecution(
        {
          bus: MakaioBus,
          activeExecutions: new Map(),
          shellAbortControllers: new Map(),
          activeRunnerSteps: new Map(),
          durableLifecycleTransitions: new Map(),
          lifecyclePublications: new Map(),
          publishingLifecycleExecutions: new Set(),
          requestAttemptCancellation: (executionId, reason) => authority.requestCancellation({ executionId, reason }),
          async notifyAttemptCancellation() {
            notifications += 1;
          },
        },
        execution.id,
        'observed worker outcome',
      ),
    ).toBe(true);
    expect(await repository.readCancellation(attempt.executionAttemptId)).toBeNull();
    expect(notifications).toBe(0);
    expect(
      (await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id })).execution,
    ).toMatchObject({ status: 'cancelled' });
  });

  it('notifies worker control before a lifecycle subscriber waits on slow work', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    await authority.createAttempt(execution.id, makeTestInstruction());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let notified = false;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), () => {
        notified = true;
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, async () => {
        entered.resolve();
        await release.promise;
      }),
    );
    const cancelling = MakaioBus.request(WorkflowSubjects.cancel, { executionId: execution.id });
    try {
      await entered.promise;
      expect(notified).toBe(true);
    } finally {
      release.resolve();
      await cancelling;
    }
  });

  it('accepts cancellation and wakes control while the preceding paused subscriber is blocked', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const runnerResult = Promise.withResolvers<WorkflowRunnerCompletion>();
    let runnerSignal: AbortSignal | undefined;
    const runner: IWorkflowRunner = {
      run(_config, signal) {
        runnerSignal = signal;
        return runnerResult.promise;
      },
    };
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority, workflowRunner: runner });
    const definition = createWorkflowDefinition();
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelledEvent = Promise.withResolvers<void>();
    const events: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.paused, async () => {
        events.push('paused');
        entered.resolve();
        await release.promise;
      }),
    );
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        events.push('cancelled');
        cancelledEvent.resolve();
      }),
    );
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: definition.id });
    const attempt = await authority.createAttempt(executionId, makeTestInstruction());
    let notified = false;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${executionId}.cancel`), () => {
        notified = true;
      }),
    );
    runnerResult.resolve({
      state: 'uncommitted',
      result: {
        executionId,
        workflowId: definition.id,
        status: 'paused',
        pausedAtGateId: 'gate-approve',
        pausedAtFrameId: 'frame-gate-1',
      },
    });
    try {
      await entered.promise;
      await expect(MakaioBus.request(WorkflowSubjects.cancel, { executionId, reason: 'operator' })).resolves.toEqual({
        cancelled: true,
      });
      expect(await authority.readCancellation(attempt.executionAttemptId)).toMatchObject({ reason: 'operator' });
      expect(notified).toBe(true);
      expect(runnerSignal?.aborted).toBe(true);
      expect(events).toEqual(['paused']);
    } finally {
      release.resolve();
    }
    await cancelledEvent.promise;
    expect(events).toEqual(['paused', 'cancelled']);
  });
});
