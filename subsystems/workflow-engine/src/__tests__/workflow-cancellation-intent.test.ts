import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { createWorkflowCancelSubject, WorkflowDefinitionSchema, WorkflowRunContextSchema } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
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

  it('commits running owner intent before notifying a controller', async () => {
    const status = 'running';
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution({ status });
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    const delivered: unknown[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), async () => {
        delivered.push(await repository.readCancellation(attempt.executionAttemptId));
      }),
    );
    await expect(
      MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, { executionId: execution.id, reason: 'operator' }),
    ).resolves.toEqual({ cancelled: true });
    expect(delivered).toEqual([
      {
        requestKey: expect.any(String),
        controlRevision: 1,
        requestedAt: expect.any(String),
        reason: 'operator',
      },
    ]);
    const replacement = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec, repository);
    expect(await replacement.readCancellation(attempt.executionAttemptId)).toEqual(delivered[0]);
    await authority.requestCancellation({ executionId: execution.id, reason: 'later request' });
    expect(await authority.readCancellation(attempt.executionAttemptId)).toEqual(delivered[0]);
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
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    let notifications = 0;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), () => {
        notifications += 1;
      }),
    );
    await expect(
      MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, { executionId: execution.id }),
    ).resolves.toEqual({
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
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, { execution });
    let notifications = 0;
    setup.cleanupFns.push(
      MakaioBus.on(createWorkflowCancelSubject(`workflow.${execution.id}.cancel`), () => {
        notifications += 1;
      }),
    );
    await expect(
      MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, { executionId: execution.id }),
    ).rejects.toThrow('cancellation store unavailable');
    expect(notifications).toBe(0);
    expect(
      (await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, { executionId: execution.id }))
        .execution,
    ).toMatchObject({ status: 'running' });
  });

  it('converges an observed cancellation without creating another control request', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution();
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, { execution });
    const attempt = await authority.createAttempt(execution.id, makeTestInstruction());
    let notifications = 0;
    expect(
      await cancelExecution(
        createTestCall(),
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
      (await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, { executionId: execution.id }))
        .execution,
    ).toMatchObject({ status: 'cancelled' });
  });

  it('converges cancellation of a running owner with a historical definition snapshot', async ({ onTestFinished }) => {
    vi.stubEnv('NODE_ENV', 'test');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    setup = await setupWorkflowExecutorTest();
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    const call = createTestCall();
    const workflow = createWorkflowDefinition();
    const execution = createWorkflowExecution({ workflowId: workflow.id, status: 'running' });
    const executionId = execution.id;
    const runContext = WorkflowRunContextSchema.parse({
      executionId,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      coordinatorSessionId: 'owner-session',
      cancelSubject: `workflow.${executionId}.cancel`,
      createdAt: 1,
      terminalAuthority: 'authority',
    });
    await MakaioBus.request(call, WorkflowStorageSubjects.setExecutionStart, { execution, runContext });

    const snapshot = {
      ...workflow,
      canvasLayout: { approval: { x: 1, y: 2 } }, // legacy-input
      root: {
        ...workflow.root,
        nodes: [
          { id: 'approval', type: 'gate', prompt: 'Approve?', autoAction: 'reject', timeoutMs: null }, // legacy-input
        ],
      },
    };
    await setup.dbContext.exec(
      sql`UPDATE workflow_run_contexts SET definition_snapshot = ${JSON.stringify(snapshot)} WHERE execution_id = ${executionId}`,
    );
    expect(WorkflowDefinitionSchema.safeParse(snapshot).success).toBe(false);
    const stored = await MakaioBus.request(call, WorkflowStorageSubjects.getRunContext, { executionId });
    expect(stored.runContext?.definitionSnapshot).toEqual(snapshot);

    const events: unknown[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
        events.push(ctx.payload);
      }),
    );
    const reason = 'Operator stopped work';
    await expect(
      setup.workflowExecutor.acceptAuthorityCancellation(call, executionId, { kind: 'cancelled', reason }),
    ).resolves.toEqual({ accepted: true, status: 'cancelled' });
    const settled = await MakaioBus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
    expect(settled.execution).toMatchObject({ status: 'cancelled', reason });
    expect(events).toEqual([
      expect.objectContaining({ executionId, workflowId: workflow.id, reason, completedAt: expect.any(Number) }),
    ]);
  });

  it('notifies worker control before a lifecycle subscriber waits on slow work', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    setup = await setupWorkflowExecutorTest({ executionAttemptAuthority: authority });
    const execution = createWorkflowExecution();
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, { execution });
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
    const cancelling = MakaioBus.request(createTestCall(), WorkflowSubjects.cancel, { executionId: execution.id });
    try {
      await entered.promise;
      expect(notified).toBe(true);
    } finally {
      release.resolve();
      await cancelling;
    }
  });
});
