import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  createWorkflowFinalizerNamespace,
  WorkerNamespace,
  WorkerSubjects,
  WorkflowWorkerConfigSchema,
  type WorkflowDefinition,
} from '@makaio/contracts';
import type { Party } from '@makaio/core';
import { createTestCall } from '@makaio/test-utils';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import { buildWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

/**
 * Persist an authority-owned execution with the portable context needed for outcome submission.
 * @param executionId - Execution receiving the submitted result.
 * @param workflow - Workflow with the selected success finalizer.
 * @returns The durable run context for the attempt instruction.
 */
async function seedAuthorityRun(executionId: string, workflow: WorkflowDefinition) {
  const runContext = {
    executionId,
    workflowId: workflow.id,
    source: { kind: 'definition' as const, workflowId: workflow.id },
    definitionSnapshot: workflow,
    workerManifest: { contributionRefs: [] },
    inputs: {},
    scope: { type: 'global' as const },
    triggerPayload: {},
    coordinatorSessionId: 'shared-recovery-session',
    cancelSubject: `workflow.${executionId}.cancel`,
    env: {},
    createdAt: Date.now(),
    terminalAuthority: 'authority' as const,
  };
  await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
    execution: createWorkflowExecution({ id: executionId, workflowId: workflow.id }),
    runContext,
  });
  return runContext;
}

describe('workflow success finalizer', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest({ initExecutor: false });
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }
  });

  it('claims, delivers, and acknowledges a selected success finalizer before projecting completion', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const finalizerId = 'test.success';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);

    let acknowledgeDelivery: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      MakaioBus.on(subjects.finalize, async (ctx) => {
        resolve();
        await new Promise<void>((acknowledge) => {
          acknowledgeDelivery = acknowledge;
        });
        await MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
          executionId: ctx.payload.executionId,
          claimToken: ctx.payload.claimToken,
          settledAt: Date.now(),
        });
        ctx.setResult({ accepted: true });
      });
    });
    await setup.workflowExecutor.init();
    await setup.workflowExecutor.registerSuccessFinalizer(finalizerId);

    const workflow = {
      ...createWorkflowDefinition({
        id: 'success-finalizer',
        name: 'Success Finalizer',
        root: { id: 'success-finalizer-root', type: 'sequence', nodes: [] },
      }),
      successFinalizerId: finalizerId,
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    let completedEvents = 0;
    const completed = new Promise<string>((resolve) => {
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedEvents += 1;
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await deliveryStarted;

    const beforeAcknowledgment = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(beforeAcknowledgment.execution).toEqual(expect.objectContaining({ status: 'finalizing' }));
    expect(beforeAcknowledgment.execution?.completedAt).toBeUndefined();
    await expect(MakaioBus.request(WorkflowSubjects.cancel, { executionId })).resolves.toEqual({ cancelled: false });
    expect(completedEvents).toBe(0);

    if (!acknowledgeDelivery) {
      throw new Error('Success finalizer delivery did not expose an acknowledgment callback.');
    }
    acknowledgeDelivery();
    await expect(completed).resolves.toBe(executionId);

    const settled = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(settled.execution).toEqual(
      expect.objectContaining({ status: 'completed', completedAt: expect.any(Number) }),
    );
    expect(completedEvents).toBe(1);
  });

  it('replays an unsettled selected finalization after executor restart', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const finalizerId = 'test.recovery';
    const { subjects } = createWorkflowFinalizerNamespace(finalizerId);
    const executionId = 'success-finalizer-recovery';
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: createWorkflowExecution({ id: executionId, workflowId: 'recovery-workflow', status: 'running' }),
    });
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, {
      claim: {
        executionId,
        workflowId: 'recovery-workflow',
        finalizerId,
        transitionKey: `${executionId}:terminal`,
        claimToken: 'recovery-claim-token',
        intent: { status: 'completed', completedAt: 2_000 },
        claimedAt: 1_500,
      },
    });

    await expect(MakaioBus.request(WorkflowStorageSubjects.listClaimedFinalizations, { finalizerId })).resolves.toEqual(
      expect.objectContaining({
        claims: [expect.objectContaining({ executionId, finalizerId, transitionKey: `${executionId}:terminal` })],
      }),
    );

    const recoveredExecutor = new WorkflowExecutor(MakaioBus, {
      stepCooldownMs: 0,
      stepTimeoutMs: 10_000,
    });
    const completed = new Promise<string>((resolve) => {
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => resolve(ctx.payload.executionId));
    });
    let recoveredClaimToken: string | undefined;
    MakaioBus.registerNamespace(createWorkflowFinalizerNamespace(finalizerId).namespace);
    MakaioBus.on(subjects.finalize, async (ctx) => {
      recoveredClaimToken = ctx.payload.claimToken;
      await MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: ctx.payload.executionId,
        claimToken: ctx.payload.claimToken,
        settledAt: Date.now(),
      });
      ctx.setResult({ accepted: true });
    });

    try {
      await recoveredExecutor.init();
      await recoveredExecutor.registerSuccessFinalizer(finalizerId);
      await expect(completed).resolves.toBe(executionId);
      expect(recoveredClaimToken).toBe('recovery-claim-token');
      const settled = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
      expect(settled.execution).toEqual(
        expect.objectContaining({ status: 'completed', completedAt: expect.any(Number) }),
      );
    } finally {
      await recoveredExecutor.destroy();
    }
  });

  it.each([
    'running',
    'finalizing',
  ] as const)('isolates foreign recovery from the submitter of a %s execution after restart', async (status) => {
    if (!setup) throw new Error('Workflow executor test setup did not initialize.');

    const runA = 'submitting-run';
    const runB = 'pending-run';
    const finalizerId = 'test.shared-recovery';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);
    MakaioBus.registerNamespace(WorkerNamespace);
    const workflow = { ...createWorkflowDefinition({ id: 'shared-recovery' }), successFinalizerId: finalizerId };
    await setup.workflowExecutor.init();
    const runContext = await seedAuthorityRun(runA, workflow);
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: createWorkflowExecution({ id: runB, workflowId: workflow.id }),
    });
    for (const executionId of status === 'finalizing' ? [runB, runA] : [runB]) {
      await expect(
        MakaioBus.request(WorkflowStorageSubjects.claimFinalization, {
          claim: {
            executionId,
            workflowId: workflow.id,
            finalizerId,
            transitionKey: `${executionId}:terminal`,
            claimToken: `${executionId}-claim`,
            intent: { status: 'completed', completedAt: 2_000 },
            claimedAt: 1_500,
          },
        }),
      ).resolves.toEqual({ claimed: true });
    }
    await setup.workflowExecutor.destroy();

    const repository = await createSqliteAttemptRepository(setup.dbContext.db, workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const attempt = await authority.createAttempt(
      runA,
      buildWorkflowAttemptInstruction({
        id: 'shared-recovery-instruction',
        revision: '1',
        runContext,
        config: WorkflowWorkerConfigSchema.parse({ ...runContext, definition: workflow }),
        preservation: { required: [] },
      }),
    );
    const recoveredExecutor = new WorkflowExecutor(MakaioBus, undefined, undefined, authority);
    const deliveries: Array<{ executionId: string; principal: Party }> = [];
    const unsubscribe = MakaioBus.on(subjects.finalize, async (ctx) => {
      const { executionId, claimToken } = ctx.payload;
      deliveries.push({ executionId, principal: ctx.call.principal });
      // Leave B pending so an outcome replay can encounter it after the registration sweep.
      if (executionId === runA) {
        await MakaioBus.request(ctx.call, WorkflowStorageSubjects.acknowledgeFinalization, {
          executionId,
          claimToken,
          settledAt: Date.now(),
        });
      }
      ctx.setResult({ accepted: true });
    });
    try {
      await recoveredExecutor.init();
      const personA = { kind: 'test.person', id: 'person-a' };
      const call = createTestCall({ principal: personA });
      await expect(
        MakaioBus.request(call, WorkerSubjects.control.outcome.submit, {
          executionAttemptId: attempt.executionAttemptId,
          executionId: runA,
          result: { executionId: runA, workflowId: workflow.id, status: 'completed' },
        }),
      ).resolves.toEqual({ decision: 'accepted' });
      const executorPrincipal = MakaioBus.own('shared-work').principal;
      const expectedPrincipals = new Map([
        [runA, personA],
        [runB, executorPrincipal],
      ]);
      expect(deliveries.map(({ executionId }) => executionId)).toEqual(expect.arrayContaining([runA, runB]));
      for (const { executionId, principal } of deliveries) {
        expect(principal).toEqual(expectedPrincipals.get(executionId));
      }
    } finally {
      unsubscribe();
      await recoveredExecutor.destroy();
    }
  });

  it('fails the engine execution when the selected finalizer rejects delivery permanently', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const finalizerId = 'test.rejecting';
    const { namespace, subjects } = createWorkflowFinalizerNamespace(finalizerId);
    MakaioBus.registerNamespace(namespace);
    MakaioBus.on(subjects.finalize, (ctx) => ctx.setResult({ accepted: false }));
    await setup.workflowExecutor.init();
    await setup.workflowExecutor.registerSuccessFinalizer(finalizerId);

    const workflow = {
      ...createWorkflowDefinition({
        id: 'success-finalizer-rejection',
        name: 'Success Finalizer Rejection',
        root: { id: 'success-finalizer-rejection-root', type: 'sequence', nodes: [] },
      }),
      successFinalizerId: finalizerId,
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const failed = new Promise<string>((resolve) => {
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => resolve(ctx.payload.executionId));
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(failed).resolves.toBe(executionId);
    const settled = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });
    expect(settled.execution).toEqual(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining(finalizerId),
        completedAt: expect.any(Number),
      }),
    );
  });
});
