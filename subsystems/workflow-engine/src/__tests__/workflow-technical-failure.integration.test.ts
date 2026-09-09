import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptSubjects,
  WorkerNamespace,
  WorkflowWorkerConfigSchema,
  WorkflowRunContextSchema,
  type ExecutionAttemptOutcome,
} from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { buildWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import {
  workflowAttemptOutcomeCodec,
  type WorkflowAttemptOutcome,
  type WorkflowAttemptTechnicalFailure,
} from '../workflow-attempt-outcome.js';
import { WorkflowExecutor } from '../workflow-executor.js';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { driveTestAttemptToAllocated } from '../testing/attempt-fixtures.js';
import { AttemptGateTransport, attemptPeer } from './execution-attempt-gate-harness.js';
import { createWorkflowExecution } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

const executionId = 'technical-owner';
const workflowId = 'not-yet-loaded';
const failure: WorkflowAttemptTechnicalFailure = {
  kind: 'technical-failure',
  stage: 'startup',
  message: 'Executable acquisition failed',
};

describe('workflow owner technical failure convergence', () => {
  let setup: WorkflowExecutorTestSetup;
  let repository: ReturnType<typeof createInMemoryAttemptRepository<WorkflowAttemptOutcome>>;
  let authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  let transport: AttemptGateTransport;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest({ initExecutor: false });
    repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    await setup.workflowExecutor.destroy();
    setup.workflowExecutor = new WorkflowExecutor(MakaioBus, undefined, undefined, authority);
    MakaioBus.registerNamespace(WorkerNamespace);
    MakaioBus.registerNamespace(ExecutionAttemptNamespace);
    transport = new AttemptGateTransport();
    MakaioBus.registerTransport(transport);
    await setup.workflowExecutor.init();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
    MakaioBus.unregisterTransport(transport.name);
  });

  async function seedOwner(terminalAuthority: 'authority' | 'worker' = 'authority') {
    const runContext = WorkflowRunContextSchema.parse({
      executionId,
      workflowId,
      source: { kind: 'source', filename: 'workflow.ts', source: 'export default unavailable;' },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'owner-session',
      cancelSubject: 'workflow.technical-owner.cancel',
      env: {},
      createdAt: 1,
      terminalAuthority,
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({ id: executionId, workflowId }),
      runContext,
    });
    return runContext;
  }

  it('commits technical failure before real owner finalization and replays without another failure event', async () => {
    const runContext = await seedOwner();
    const instruction = buildWorkflowAttemptInstruction({
      id: 'instruction',
      revision: '1',
      preservation: { required: [] },
      config: WorkflowWorkerConfigSchema.parse(runContext),
    });
    const { executionAttemptId } = await authority.createAttempt(executionId, instruction);
    await driveTestAttemptToAllocated(authority, executionAttemptId, executionId);
    const registration = await authority.registerRuntime({
      executionId,
      executionAttemptId,
      runtimeIncarnationId: 'runtime',
    });
    if (registration.kind !== 'registered') throw new Error(registration.kind);
    const observations: unknown[] = [];
    const off = MakaioBus.on(WorkflowSubjects.execution.failed, () => {
      observations.push(repository.committedOutcomes.get(executionAttemptId));
    });
    setup.cleanupFns.push(off);
    const subject = ExecutionAttemptSubjects.outcome.submit;
    const submit = () =>
      transport.requestAs(
        subject.$meta.namespace,
        subject.subject as string,
        {
          executionAttemptId,
          runtimeGeneration: registration.runtimeGeneration,
          outcome: failure,
        },
        attemptPeer(executionAttemptId, executionId),
      );

    expect(await submit()).toMatchObject({ result: { decision: 'accepted' } });
    expect(observations).toEqual([JSON.stringify(failure)]);
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution).toMatchObject({ status: 'failed', error: 'startup: Executable acquisition failed' });
    expect(repository.committedOutcomes.get(executionAttemptId)).toEqual(JSON.stringify(failure));
    expect(await submit()).toMatchObject({ result: { decision: 'duplicate' } });
    expect(observations).toHaveLength(1);
  });

  it.each(['completed', 'paused', 'finalizing'] as const)('does not overwrite a %s workflow owner', async (status) => {
    await seedOwner();
    await MakaioBus.request(WorkflowStorageSubjects.updateExecution, { executionId, status });
    await expect(setup.workflowExecutor.acceptAuthorityTechnicalFailure(executionId, failure)).rejects.toThrow(
      'conflicts',
    );
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution?.status).toBe(status);
  });

  it('refuses worker-owned lifecycle without loading the executable definition', async () => {
    await seedOwner('worker');
    await expect(setup.workflowExecutor.acceptAuthorityTechnicalFailure(executionId, failure)).rejects.toThrow(
      'terminalAuthority=authority',
    );
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution?.status).toBe('running');
  });

  async function cancellationAttempt(duringPreparation: boolean) {
    const runContext = await seedOwner();
    const instruction = buildWorkflowAttemptInstruction({
      id: 'cancel-instruction',
      revision: '1',
      preservation: { required: [] },
      config: WorkflowWorkerConfigSchema.parse(runContext),
      ...(duringPreparation
        ? {
            workspace: {
              provisioning: 'create' as const,
              custody: 'disposable' as const,
              sourceRoots: [],
              setup: [],
            },
          }
        : {}),
    });
    const { executionAttemptId } = await authority.createAttempt(executionId, instruction);
    await driveTestAttemptToAllocated(authority, executionAttemptId, executionId);
    const registration = await authority.registerRuntime({
      executionId,
      executionAttemptId,
      runtimeIncarnationId: 'runtime',
    });
    if (registration.kind !== 'registered') throw new Error(registration.kind);
    const { runtimeGeneration } = registration;
    let operationId: string | undefined;
    if (duringPreparation) {
      await authority.markRuntimeReady({
        executionId,
        executionAttemptId,
        runtimeGeneration,
        readyAt: new Date().toISOString(),
      });
      const admitted = await authority.admitOperation({
        executionId,
        executionAttemptId,
        runtimeGeneration,
        operationKind: 'workspace-preparation',
        admissionKey: 'prepare',
      });
      if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
      operationId = admitted.operationId;
    }
    const outcome = { kind: 'cancelled' as const, reason: 'Requested stop was observed' };
    const subject = ExecutionAttemptSubjects.outcome.submit;
    return {
      executionAttemptId,
      outcome,
      submit: (report: ExecutionAttemptOutcome = outcome) =>
        transport.requestAs(
          subject.$meta.namespace,
          subject.subject as string,
          {
            executionAttemptId,
            runtimeGeneration,
            ...(operationId !== undefined ? { operationId } : {}),
            outcome: report,
          },
          attemptPeer(executionAttemptId, executionId),
        ),
    };
  }

  it.each([
    false,
    true,
  ])('preserves public cancellation when a technical stop failure follows (race: %s)', async (race) => {
    const attempt = await cancellationAttempt(true);
    const stopFailure: WorkflowAttemptTechnicalFailure = {
      kind: 'technical-failure',
      stage: 'workspace-preparation',
      message: 'Setup process group did not stop',
    };
    const waiter = authority.waitForOutcome(attempt.executionAttemptId);
    expect(waiter).toBeDefined();
    const events: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        events.push('cancelled');
      }),
      MakaioBus.on(WorkflowSubjects.execution.failed, () => {
        events.push('failed');
      }),
    );
    let submission: ReturnType<typeof attempt.submit>;
    if (race) {
      // Hold convergence after its initial owner read, so cancellation wins
      // before the failure finalizer rechecks the durable lifecycle state.
      const ownerRead = Promise.withResolvers<void>();
      const readReached = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      let held = false;
      setup.cleanupFns.push(
        MakaioBus.on(
          WorkflowStorageSubjects.getExecution,
          async (ctx) => {
            await ctx.next();
            ownerRead.resolve();
          },
          { priority: 100 },
        ),
        MakaioBus.on(
          WorkflowStorageSubjects.getRunContext,
          async (ctx) => {
            await ctx.next();
            if (held) return;
            held = true;
            await ownerRead.promise;
            readReached.resolve();
            await releaseRead.promise;
          },
          { priority: 100 },
        ),
      );
      submission = attempt.submit(stopFailure);
      try {
        await readReached.promise;
        expect(
          await MakaioBus.request(WorkflowSubjects.cancel, { executionId, reason: 'Operator stopped work' }),
        ).toMatchObject({ cancelled: true });
      } finally {
        releaseRead.resolve();
      }
    } else {
      expect(
        await MakaioBus.request(WorkflowSubjects.cancel, { executionId, reason: 'Operator stopped work' }),
      ).toMatchObject({ cancelled: true });
      submission = attempt.submit(stopFailure);
    }
    expect(await submission).toMatchObject({ result: { decision: 'accepted' } });
    await expect(waiter).resolves.toEqual({
      outcome: stopFailure,
      acceptance: 'recorded-only',
      controlObservation: expect.objectContaining({ controlRevision: race ? 0 : 1 }),
    });
    expect(await attempt.submit(stopFailure)).toMatchObject({ result: { decision: 'duplicate' } });
    expect(repository.committedOutcomes.get(attempt.executionAttemptId)).toBe(JSON.stringify(stopFailure));
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution).toMatchObject({ status: 'cancelled', reason: 'Operator stopped work' });
    expect(events).toEqual(['cancelled']);
  });

  it.each([
    false,
    true,
  ])('commits cancellation then finalizes an unloaded owner (during Preparation: %s)', async (duringPreparation) => {
    const attempt = await cancellationAttempt(duringPreparation);
    const observations: unknown[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        observations.push(repository.committedOutcomes.get(attempt.executionAttemptId));
      }),
    );
    expect(await attempt.submit()).toMatchObject({ result: { decision: 'accepted' } });
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution).toMatchObject({ status: 'cancelled', reason: attempt.outcome.reason });
    expect(observations).toEqual([JSON.stringify(attempt.outcome)]);
    expect(await attempt.submit()).toMatchObject({ result: { decision: 'duplicate' } });
    expect(observations).toHaveLength(1);
  });

  it('does not overwrite a completed owner when cancellation convergence conflicts', async () => {
    const attempt = await cancellationAttempt(false);
    await MakaioBus.request(WorkflowStorageSubjects.updateExecution, { executionId, status: 'completed' });
    const response = await attempt.submit();
    expect(response.error).toBeDefined();
    expect(response.result).toBeUndefined();
    const stored = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution?.status).toBe('completed');
  });

  it('accepts a real stopped outcome when control committed but owner cancellation is still pending', async () => {
    const attempt = await cancellationAttempt(false);
    await authority.requestCancellation({ executionId, reason: 'Operator requested stop' });
    expect((await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'running',
    );
    const waiter = authority.waitForOutcome(attempt.executionAttemptId);
    expect(await attempt.submit()).toMatchObject({ result: { decision: 'accepted' } });
    await expect(waiter).resolves.toEqual({
      outcome: attempt.outcome,
      acceptance: 'projected',
      controlObservation: expect.objectContaining({ controlRevision: 1 }),
    });
    expect((await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'cancelled',
    );
  });
});
