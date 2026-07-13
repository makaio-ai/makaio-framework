import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { registerDrizzleWorkflowStorage } from '../storage/handler.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { createWorkflowFinalizerNamespace } from '@makaio/contracts';
import { eq } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { workflowEngineSchema } from '../storage/schema.variants.js';
import { createTestDb, createWorkflowExecution, type TestDbContext } from './shared.js';

const claim = {
  executionId: 'execution-finalization-1',
  workflowId: 'workflow-finalization-1',
  finalizerId: 'audit.lifecycle',
  transitionKey: 'execution-finalization-1:terminal',
  claimToken: 'claim-token-1',
  intent: { status: 'completed' as const, completedAt: 2_000 },
  claimedAt: 1_500,
};

describe('workflow finalization storage', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    dbContext = await createTestDb();
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: createWorkflowExecution({
        id: claim.executionId,
        workflowId: claim.workflowId,
        status: 'running',
        startedAt: 1_000,
      }),
    });
  });

  afterEach(() => dbContext.cleanup());

  it('claims running state once and preserves recovery ownership across handler restart', async () => {
    await expect(MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim })).resolves.toEqual({
      claimed: true,
    });
    await expect(MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim })).resolves.toEqual({
      claimed: true,
    });
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    const cleanupRestartedHandlers = registerDrizzleWorkflowStorage(MakaioBus, dbContext.db);

    const recovered = await MakaioBus.request(WorkflowStorageSubjects.listClaimedFinalizations, {
      finalizerId: claim.finalizerId,
    });

    expect(recovered.claims).toEqual([claim]);
    cleanupRestartedHandlers();
  });

  it('acknowledges once and treats duplicate or late settlement deterministically', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        settledAt: 2_100,
      }),
    ).resolves.toEqual({ acknowledged: true });
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        settledAt: 2_200,
      }),
    ).resolves.toEqual({ acknowledged: true });
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.failFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        error: 'too late',
        settledAt: 2_300,
      }),
    ).resolves.toEqual({ failed: false });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: claim.executionId,
    });
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', completedAt: 2_000 }));
  });

  it('rejects a conflicting token without changing the claimed transition', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: claim.executionId,
        claimToken: 'conflicting-token',
        settledAt: 2_100,
      }),
    ).resolves.toEqual({ acknowledged: false });
    const recovered = await MakaioBus.request(WorkflowStorageSubjects.listClaimedFinalizations, {
      finalizerId: claim.finalizerId,
    });
    expect(recovered.claims).toEqual([claim]);
  });

  it('permanently fails finalization and rejects a late acknowledgment', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.failFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        error: 'lifecycle delivery exhausted',
        settledAt: 2_500,
      }),
    ).resolves.toEqual({ failed: true });
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        settledAt: 2_600,
      }),
    ).resolves.toEqual({ acknowledged: false });
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: claim.executionId,
    });
    expect(execution).toEqual(
      expect.objectContaining({ status: 'failed', error: 'lifecycle delivery exhausted', completedAt: 2_500 }),
    );
  });

  it('serializes concurrent publication so one terminal event is emitted', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });
    await settleWithoutPublishing();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let emissions = 0;
    const stopCapture = MakaioBus.on(WorkflowSubjects.execution.completed, async () => {
      emissions += 1;
      started.resolve();
      await release.promise;
    });

    const first = MakaioBus.request(WorkflowStorageSubjects.publishFinalization, { claim });
    await started.promise;
    const second = MakaioBus.request(WorkflowStorageSubjects.publishFinalization, { claim });
    release.resolve();
    await Promise.all([first, second]);

    expect(emissions).toBe(1);
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.listUnpublishedFinalizations, { finalizerId: claim.finalizerId }),
    ).resolves.toEqual({ claims: [] });
    stopCapture();
  });

  it('rejects stale publication identity and emits durable metadata only', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });
    await settleWithoutPublishing();
    const published: unknown[] = [];
    const stopCapture = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
      published.push(ctx.payload);
    });
    const mismatches = [
      { ...claim, workflowId: 'stale-workflow' },
      { ...claim, finalizerId: 'stale-finalizer' },
      { ...claim, transitionKey: 'stale-transition' },
      { ...claim, claimToken: 'stale-token' },
    ];

    for (const staleClaim of mismatches) {
      await expect(
        MakaioBus.request(WorkflowStorageSubjects.publishFinalization, { claim: staleClaim }),
      ).rejects.toThrow('does not match durable transition');
    }
    await MakaioBus.request(WorkflowStorageSubjects.publishFinalization, { claim });

    expect(published).toEqual([
      expect.objectContaining({
        executionId: claim.executionId,
        workflowId: claim.workflowId,
        transitionKey: claim.transitionKey,
      }),
    ]);
    stopCapture();
  });

  it('replays the same terminal transition after an emit crash and marks it only after success', async () => {
    await MakaioBus.request(WorkflowStorageSubjects.claimFinalization, { claim });
    const stopCrashing = MakaioBus.on(WorkflowSubjects.execution.completed, () => {
      throw new Error('simulated lifecycle consumer crash');
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
        executionId: claim.executionId,
        claimToken: claim.claimToken,
        settledAt: 2_100,
      }),
    ).rejects.toThrow('simulated lifecycle consumer crash');
    stopCrashing();

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.listUnpublishedFinalizations, { finalizerId: claim.finalizerId }),
    ).resolves.toEqual({
      claims: [claim],
    });
    const { workflowFinalizations } = resolveSchema(dbContext.db, workflowEngineSchema);
    const beforeRestart = await dbContext.db
      .select({ publishedAt: workflowFinalizations.publishedAt })
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, claim.executionId));
    expect(beforeRestart).toEqual([{ publishedAt: null }]);
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(WorkflowStorageNamespace);
    const cleanupRestartedHandlers = registerDrizzleWorkflowStorage(MakaioBus, dbContext.db);
    const restartedExecutor = new WorkflowExecutor(MakaioBus, { stepCooldownMs: 0, stepTimeoutMs: 10_000 });
    await restartedExecutor.init();
    const { namespace, subjects } = createWorkflowFinalizerNamespace(claim.finalizerId);
    MakaioBus.registerNamespace(namespace);
    const stopFinalize = MakaioBus.on(subjects.finalize, () => {
      throw new Error('Settled claims must not be delivered to the finalizer again');
    });
    const published: string[] = [];
    const stopCapture = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
      published.push(ctx.payload.transitionKey ?? 'missing');
    });
    await restartedExecutor.registerSuccessFinalizer(claim.finalizerId);

    expect(published).toEqual([claim.transitionKey]);
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.listUnpublishedFinalizations, { finalizerId: claim.finalizerId }),
    ).resolves.toEqual({
      claims: [],
    });
    const afterReplay = await dbContext.db
      .select({ publishedAt: workflowFinalizations.publishedAt })
      .from(workflowFinalizations)
      .where(eq(workflowFinalizations.executionId, claim.executionId));
    expect(afterReplay).toEqual([{ publishedAt: expect.any(Number) }]);
    await restartedExecutor.destroy();
    cleanupRestartedHandlers();
    stopFinalize();
    stopCapture();
  });
});

async function settleWithoutPublishing(): Promise<void> {
  const stopCrashing = MakaioBus.on(WorkflowSubjects.execution.completed, () => {
    throw new Error('simulated lifecycle consumer crash');
  });
  try {
    await MakaioBus.request(WorkflowStorageSubjects.acknowledgeFinalization, {
      executionId: claim.executionId,
      claimToken: claim.claimToken,
      settledAt: 2_100,
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('simulated lifecycle consumer crash')) throw error;
  } finally {
    stopCrashing();
  }
}
