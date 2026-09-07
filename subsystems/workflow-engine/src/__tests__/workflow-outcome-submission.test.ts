import { createBusContext, createBusInstance } from '@makaio/bus-core';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptSubjects,
  WorkerNamespace,
  WorkerSubjects,
  WorkflowWorkerConfigSchema,
  type ExecutionAttemptOutcomeSubmitRequest,
} from '@makaio/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { WorkflowNamespace, WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { driveTestAttemptToAllocated } from '../testing/attempt-fixtures.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { buildWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import {
  workflowAttemptOutcomeCodec,
  type WorkflowAttemptCancellation,
  type WorkflowAttemptTechnicalFailure,
} from '../workflow-attempt-outcome.js';
import { cancelExecution, completeExecutionWithFailure, type FinalizerDeps } from '../workflow-execution-finalizer.js';
import { registerOutcomeSubmissionHandler } from '../workflow-outcome-submission.js';
import { AttemptGateTransport, attemptPeer } from './execution-attempt-gate-harness.js';
import { createTestDbForBus, createWorkflowExecution } from './shared.js';

const executionId = 'workflow-owner-1';
const workflowId = 'workflow-1';

/** Real Attempt persistence, workflow SQLite storage, Bus ingress, and workflow failure finalizer. */
async function createHarness() {
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespaces([ExecutionAttemptNamespace, WorkerNamespace, WorkflowNamespace]);
  const db = await createTestDbForBus(bus);
  const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
  const transport = new AttemptGateTransport();
  bus.registerTransport(transport);
  const observations = {
    failures: [] as WorkflowAttemptTechnicalFailure[],
    cancellations: [] as WorkflowAttemptCancellation[],
    failedEvents: 0,
    cancelledEvents: 0,
    failAfterFinalization: false,
  };
  const finalizer: FinalizerDeps = {
    bus,
    activeExecutions: new Map(),
    shellAbortControllers: new Map(),
    activeRunnerSteps: new Map(),
    durableLifecycleTransitions: new Map(),
    lifecyclePublications: new Map(),
    publishingLifecycleExecutions: new Set(),
  };
  const cleanupEvent = bus.on(WorkflowSubjects.execution.failed, () => {
    observations.failedEvents++;
  });
  const cleanupCancelledEvent = bus.on(WorkflowSubjects.execution.cancelled, () => {
    observations.cancelledEvents++;
  });
  const cleanupHandlers = registerOutcomeSubmissionHandler(bus, {
    bus,
    authority,
    acceptTerminalResult: async (ownerId, result) => {
      if (result.status !== 'failed') throw new Error('This fixture exercises failed workflow results');
      const stored = await bus.request(WorkflowStorageSubjects.getExecution, { executionId: ownerId });
      if (!stored.execution) throw new Error('Workflow execution is missing');
      await completeExecutionWithFailure(finalizer, stored.execution, ownerId, result.error);
      return { accepted: true, status: 'failed' };
    },
    acceptTechnicalFailure: async (ownerId, failure) => {
      expect([...repository.committedOutcomes.values()]).toEqual([JSON.stringify(failure)]);
      observations.failures.push(failure);
      const stored = await bus.request(WorkflowStorageSubjects.getExecution, { executionId: ownerId });
      if (!stored.execution) throw new Error('Workflow execution is missing');
      await completeExecutionWithFailure(finalizer, stored.execution, ownerId, `${failure.stage}: ${failure.message}`);
      if (observations.failAfterFinalization) {
        observations.failAfterFinalization = false;
        throw new Error('Owner acknowledgement interrupted');
      }
      const settled = await bus.request(WorkflowStorageSubjects.getExecution, { executionId: ownerId });
      return { accepted: settled.execution?.status === 'failed', status: settled.execution!.status };
    },
    acceptCancellation: async (ownerId, cancellation) => {
      expect([...repository.committedOutcomes.values()]).toEqual([JSON.stringify(cancellation)]);
      observations.cancellations.push(cancellation);
      await cancelExecution(finalizer, ownerId, cancellation.reason);
      if (observations.failAfterFinalization) {
        observations.failAfterFinalization = false;
        throw new Error('Owner acknowledgement interrupted');
      }
      const settled = await bus.request(WorkflowStorageSubjects.getExecution, { executionId: ownerId });
      return { accepted: settled.execution?.status === 'cancelled', status: settled.execution!.status };
    },
  });
  await bus.request(WorkflowStorageSubjects.setExecution, {
    execution: createWorkflowExecution({ id: executionId, workflowId }),
  });
  return {
    bus,
    repository,
    authority,
    transport,
    observations,
    cleanup: () => {
      cleanupHandlers();
      cleanupEvent();
      cleanupCancelledEvent();
      db.cleanup();
    },
  };
}

/**
 * Create a ready Attempt without relying on a mutable run-context lookup.
 * @param harness - Real Authority and workflow storage fixture.
 * @param workspace - Whether this Attempt requires project Workspace Preparation.
 */
async function readyAttempt(harness: Awaited<ReturnType<typeof createHarness>>, workspace = false) {
  const instruction = buildWorkflowAttemptInstruction({
    id: 'instruction-1',
    revision: '1',
    preservation: { required: [] },
    config: WorkflowWorkerConfigSchema.parse({
      executionId,
      workflowId,
      source: { kind: 'source', filename: 'workflow.ts', source: 'export default workflow;' },
      coordinatorSessionId: 'session-1',
      cancelSubject: `workflow.${executionId}.cancel`,
    }),
    ...(workspace
      ? { workspace: { provisioning: 'bind' as const, custody: 'external' as const, sourceRoots: [], setup: [] } }
      : {}),
  });
  const attempt = await harness.authority.createAttempt(executionId, instruction);
  const executionAttemptId = attempt.executionAttemptId;
  await driveTestAttemptToAllocated(harness.authority, executionAttemptId, executionId);
  const runtime = await harness.authority.registerRuntime({
    executionAttemptId,
    executionId,
    runtimeIncarnationId: 'runtime-1',
  });
  if (runtime.kind !== 'registered') throw new Error('Runtime registration failed');
  const runtimeGeneration = runtime.runtimeGeneration;
  const ready = await harness.authority.markRuntimeReady({
    executionAttemptId,
    executionId,
    runtimeGeneration,
    readyAt: new Date().toISOString(),
  });
  if (ready.kind !== 'ready') throw new Error('Runtime readiness failed');
  return { executionAttemptId, runtimeGeneration };
}

describe('workflow owner canonical outcome ingress', () => {
  let harness: Awaited<ReturnType<typeof createHarness>>;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(() => {
    harness.cleanup();
  });

  function submit(request: ExecutionAttemptOutcomeSubmitRequest) {
    const subject = ExecutionAttemptSubjects.outcome.submit;
    return harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      request,
      attemptPeer(request.executionAttemptId, executionId),
    );
  }

  it('commits a startup technical failure before failing the workflow and acknowledging the Runtime', async () => {
    const identity = await readyAttempt(harness);
    const failure: WorkflowAttemptTechnicalFailure = {
      kind: 'technical-failure',
      stage: 'startup',
      message: 'Adapter missing',
    };
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    const response = await submit({ ...identity, outcome: failure });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual(failure);
    const stored = await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(stored.execution).toMatchObject({ status: 'failed', error: 'startup: Adapter missing' });
    expect(JSON.parse(harness.repository.committedOutcomes.get(identity.executionAttemptId)!)).toEqual(failure);
    expect(harness.observations.failedEvents).toBe(1);
  });

  it('reconverges a duplicate Preparation failure after owner state changed without rerunning Preparation', async () => {
    const identity = await readyAttempt(harness, true);
    const admitted = await harness.authority.admitOperation({
      ...identity,
      executionId,
      operationKind: 'workspace-preparation',
      admissionKey: 'prepare-1',
    });
    if (admitted.kind !== 'admitted') throw new Error('Preparation admission failed');
    const request: ExecutionAttemptOutcomeSubmitRequest = {
      ...identity,
      operationId: admitted.operationId,
      outcome: { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Setup failed' },
    };
    harness.observations.failAfterFinalization = true;
    expect((await submit(request)).error?.message).toContain('Owner acknowledgement interrupted');
    expect((await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'failed',
    );
    expect((await submit(request)).result).toEqual({ decision: 'duplicate' });
    expect(harness.observations.failures).toHaveLength(2);
    expect(harness.observations.failedEvents).toBe(1);
    expect(await harness.authority.getAttemptControlState(identity.executionAttemptId)).toMatchObject({
      activeOperationId: admitted.operationId,
      activeOperationKind: 'workspace-preparation',
      operationStartGate: 'closed',
    });
  });

  it('keeps paused workflow results and their gate identity on the existing owner pause path', async () => {
    const identity = await readyAttempt(harness);
    const admitted = await harness.authority.admitOperation({
      ...identity,
      executionId,
      operationKind: 'workload-invocation',
      admissionKey: 'invoke-1',
    });
    if (admitted.kind !== 'admitted') throw new Error('Invocation admission failed');
    const paused = {
      executionId,
      workflowId,
      status: 'paused' as const,
      pausedAtGateId: 'gate-1',
      pausedAtFrameId: 'frame-1',
    };
    const request: ExecutionAttemptOutcomeSubmitRequest = {
      ...identity,
      operationId: admitted.operationId,
      outcome: { kind: 'workload-result', result: paused },
    };
    expect((await submit(request)).result).toEqual({ decision: 'accepted' });
    expect((await submit(request)).result).toEqual({ decision: 'duplicate' });
    expect((await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'paused',
    );
    expect(JSON.parse(harness.repository.committedOutcomes.get(identity.executionAttemptId)!)).toEqual(paused);
    expect(harness.observations.failures).toEqual([]);
  });

  it('commits confirmed cancellation before owner convergence and reconverges an interrupted acknowledgement', async () => {
    const identity = await readyAttempt(harness);
    const cancellation: WorkflowAttemptCancellation = { kind: 'cancelled', reason: 'Owner requested stop' };
    const request: ExecutionAttemptOutcomeSubmitRequest = { ...identity, outcome: cancellation };
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    harness.observations.failAfterFinalization = true;

    expect((await submit(request)).error?.message).toContain('Owner acknowledgement interrupted');
    expect(JSON.parse(harness.repository.committedOutcomes.get(identity.executionAttemptId)!)).toEqual(cancellation);
    expect((await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution).toMatchObject({
      status: 'cancelled',
      reason: cancellation.reason,
    });
    expect((await submit(request)).result).toEqual({ decision: 'duplicate' });
    await expect(waiter).resolves.toEqual(cancellation);
    expect(harness.observations.cancellations).toEqual([cancellation, cancellation]);
    expect(harness.observations.cancelledEvents).toBe(1);
    expect(harness.observations.failures).toEqual([]);
    expect(harness.observations.failedEvents).toBe(0);
  });

  it('routes the still-used workflow-only endpoint through the same frozen-instruction convergence', async () => {
    const identity = await readyAttempt(harness);
    const result = { executionId, workflowId, status: 'failed' as const, error: 'Workflow failed' };
    const response = await harness.bus.request(WorkerSubjects.control.outcome.submit, {
      executionId,
      executionAttemptId: identity.executionAttemptId,
      result,
    });
    expect(response).toEqual({ decision: 'accepted' });
    expect((await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'failed',
    );
    expect(JSON.parse(harness.repository.committedOutcomes.get(identity.executionAttemptId)!)).toEqual(result);
  });

  it('rejects a workflow result with another immutable identity before committing it', async () => {
    const identity = await readyAttempt(harness);
    await expect(
      harness.bus.request(WorkerSubjects.control.outcome.submit, {
        executionId,
        executionAttemptId: identity.executionAttemptId,
        result: { executionId, workflowId: 'another-workflow', status: 'completed' },
      }),
    ).rejects.toThrow('frozen instruction');
    expect(harness.repository.committedOutcomes.size).toBe(0);
    expect((await harness.bus.request(WorkflowStorageSubjects.getExecution, { executionId })).execution?.status).toBe(
      'running',
    );
  });
});
