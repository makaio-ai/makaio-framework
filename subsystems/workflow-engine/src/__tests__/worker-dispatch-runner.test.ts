import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNamespace, WorkerSubjects, WorkflowRunContextSchema } from '@makaio/contracts';
import type { ProviderAllocationRef, WorkerRequirements, WorkflowRunResult } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { hasWorkerDispatchRequirements, createWorkerDispatchRunner } from '../worker-dispatch-runner.js';
import { launchDefinitionExecutionTask } from '../workflow-definition-dispatch.js';
import type { StartExecutionDeps } from '../workflow-execution-start.js';
import type { DefinitionRunnerTaskParams } from '../workflow-runner-tasks.js';
import { beginTestProvisioning, createInMemoryAttemptRepository } from '../testing/index.js';
import { workflowAttemptOutcomeCodec } from '../workflow-attempt-outcome.js';
import { parseWorkflowAttemptInstruction } from '../workflow-attempt-instruction.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowExecution } from './shared.js';

function makeWorkerConfig(): Parameters<NonNullable<ReturnType<typeof createWorkerDispatchRunner>>['run']>[0] {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
    definition: {
      id: 'workflow-1',
      name: 'Test workflow',
      root: { id: 'root', type: 'sequence', nodes: [] },
      scope: { type: 'global' },
    },
    executionId: 'wfx-1',
    workflowId: 'workflow-1',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    suspensionStrategy: 'wait-in-process',
  };
}

const TEST_ALLOCATION_REF: ProviderAllocationRef = {
  version: 1,
  providerId: 'test-provider',
  providerData: {},
};

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('hasWorkerDispatchRequirements', () => {
  it('honors local owner admission before creating a bus-dispatched attempt', async () => {
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const runner = createWorkerDispatchRunner({
      bus: createBusInstance(),
      authority,
      requirements: { recoverableAllocation: true },
    });
    if (runner === undefined) throw new Error('Expected dispatch-capable runner');
    await expect(
      runner.run(makeWorkerConfig(), new AbortController().signal, undefined, {
        withAttemptCreation: async () => {
          throw new Error('Owner already cancelled');
        },
      }),
    ).rejects.toThrow('Owner already cancelled');
    expect(repository.attempts.size).toBe(0);
  });
  it('returns false when no requirements are present', () => {
    expect(hasWorkerDispatchRequirements(undefined)).toBe(false);
  });

  it('returns false when customCapabilities are empty', () => {
    const requirements: WorkerRequirements = {
      customCapabilities: [],
    };
    expect(hasWorkerDispatchRequirements(requirements)).toBe(false);
  });

  it('returns false for an empty requirements object', () => {
    expect(hasWorkerDispatchRequirements({})).toBe(false);
  });

  it('returns true when customCapabilities are present', () => {
    const requirements: WorkerRequirements = {
      customCapabilities: ['workflow.remote'],
    };
    expect(hasWorkerDispatchRequirements(requirements)).toBe(true);
  });

  it('returns true when only recoverableAllocation is set', () => {
    expect(hasWorkerDispatchRequirements({ recoverableAllocation: true })).toBe(true);
  });

  it('returns true when only materializationModes are set', () => {
    expect(
      hasWorkerDispatchRequirements({
        materializationModes: ['workspace-snapshot'],
      }),
    ).toBe(true);
  });

  it('returns false for materializationModes with an empty array', () => {
    expect(hasWorkerDispatchRequirements({ materializationModes: [] })).toBe(false);
  });

  it('returns true when only persistentStorage is set', () => {
    expect(hasWorkerDispatchRequirements({ persistentStorage: true })).toBe(true);
  });

  it('returns true when only maxRuntimeMs is set', () => {
    expect(hasWorkerDispatchRequirements({ maxRuntimeMs: 60_000 })).toBe(true);
  });
});

describe('createWorkerDispatchRunner', () => {
  it('cancels a pending owner-context bus read without creating an Attempt or dispatching', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const offRead = bus.on(WorkflowStorageSubjects.getRunContext, async (ctx) => {
      entered.resolve();
      await release.promise;
      ctx.setResult({ runContext: null });
    });
    const dispatch = vi.fn();
    const offDispatch = bus.on(WorkerSubjects.dispatch, dispatch);
    const runner = createWorkerDispatchRunner({ bus, authority, requirements: { customCapabilities: ['test'] } });
    const controller = new AbortController();
    try {
      const result = runner!.run(
        { ...makeWorkerConfig(), source: { kind: 'path', path: '/host/workflow.ts' } },
        controller.signal,
      );
      const rejected = expect(result).rejects.toThrow('owner-read-cancelled');
      await entered.promise;
      controller.abort(new Error('owner-read-cancelled'));
      // The bus rejects before its storage handler is released.
      await rejected;
      expect(repository.attempts.size).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      offRead();
      offDispatch();
    }
  });

  it('freezes portable path input before dispatch without persisting host credentials or creating a Workspace', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const config = {
      ...makeWorkerConfig(),
      source: { kind: 'path' as const, path: '/host/workflows/test.ts' },
      busAuth: { kind: 'hmac' as const, secret: 'test-only-secret' },
      env: { PRIVATE_TOKEN: 'test-only-token' },
    };
    const runContext = WorkflowRunContextSchema.parse({
      ...config,
      source: { kind: 'path', path: 'workflows/test.ts' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'source',
        rootDigest: 'revision-1',
        sourcePath: 'workflows/test.ts',
      },
      inputs: { revision: 'original' },
      createdAt: 1,
    });
    const offRead = bus.on(WorkflowStorageSubjects.getRunContext, (ctx) => {
      expect(repository.attempts.size).toBe(0);
      ctx.setResult({ runContext });
    });
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      runContext.inputs = { revision: 'changed after creation' };
      const instruction = await authority.getInstruction({
        executionId: config.executionId,
        executionAttemptId: ctx.payload.executionAttemptId,
      });
      expect(instruction).not.toBeNull();
      expect(parseWorkflowAttemptInstruction(instruction!)).toMatchObject({
        source: { kind: 'path', path: 'workflows/test.ts' },
        inputs: { revision: 'original' },
      });
      expect(instruction!.workspace).toBeUndefined();
      expect(JSON.stringify(instruction)).not.toContain('/host/');
      expect(JSON.stringify(instruction)).not.toContain('test-only-');
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        config.executionId,
        authority.canonicalizeOutcome({
          executionId: config.executionId,
          workflowId: config.workflowId,
          status: 'completed',
        }),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });
    try {
      const runner = createWorkerDispatchRunner({ bus, authority, requirements: { recoverableAllocation: true } });
      await expect(runner!.run(config, new AbortController().signal)).resolves.toMatchObject({
        state: 'authority-committed',
      });
    } finally {
      offRead();
      offDispatch();
    }
  });

  it('returns undefined when no capability constraint exists', () => {
    const bus = createBusInstance();
    const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
      bootstrapTimeoutMs: 60_000,
    });
    const runner = createWorkerDispatchRunner({
      bus,
      requirements: undefined,
      authority,
    });
    expect(runner).toBeUndefined();
  });

  it('returns undefined when customCapabilities are empty', () => {
    const bus = createBusInstance();
    const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
      bootstrapTimeoutMs: 60_000,
    });
    const runner = createWorkerDispatchRunner({
      bus,
      requirements: { customCapabilities: [] },
      authority,
    });
    expect(runner).toBeUndefined();
  });

  it('abandons the durable pending attempt and removes its waiter when dispatch has no handler', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const runner = createWorkerDispatchRunner({
      bus,
      requirements: { customCapabilities: ['workflow.remote'] },
      authority,
    });

    await expect(runner!.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow();

    const [attempt] = repository.attempts.values();
    expect(attempt).toMatchObject({
      executionId: 'wfx-1',
      status: 'settled',
      settlementKind: 'abandoned',
    });
    expect(authority.waitForOutcome(attempt!.executionAttemptId)).toBeUndefined();
  });

  it('rejects the runner without terminalizing durable state when dispatch rejects its local waiter', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const localFailure = new Error('provider cleanup requires recovery');
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      await beginTestProvisioning(authority, ctx.payload.executionAttemptId, ctx.payload.config.executionId);
      authority.rejectAndDiscardWaiter(ctx.payload.executionAttemptId, localFailure);
      throw localFailure;
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        authority,
      });

      await expect(runner!.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow(
        'provider cleanup requires recovery',
      );

      const [attempt] = repository.attempts.values();
      expect(attempt).toMatchObject({
        executionId: 'wfx-1',
        status: 'provisioning',
        settlementKind: null,
      });
      expect(authority.waitForOutcome(attempt!.executionAttemptId)).toBeUndefined();
    } finally {
      offDispatch();
    }
  });

  it('awaits the canonical outcome when allocation persists before the dispatch acknowledgement rejects', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      const claim = await beginTestProvisioning(
        authority,
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
      );
      await authority.recordAllocation({ claim, allocationRef: TEST_ALLOCATION_REF });
      queueMicrotask(async () => {
        const result: WorkflowRunResult = {
          executionId: ctx.payload.config.executionId,
          workflowId: ctx.payload.config.workflowId,
          status: 'completed',
        };
        const decision = await authority.commitOutcome(
          ctx.payload.executionAttemptId,
          ctx.payload.config.executionId,
          authority.canonicalizeOutcome(result),
        );
        authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      });
      throw new Error('dispatch acknowledgement lost');
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        authority,
      });

      await expect(runner!.run(makeWorkerConfig(), new AbortController().signal)).resolves.toMatchObject({
        state: 'authority-committed',
        result: { status: 'completed' },
      });

      const [attempt] = repository.attempts.values();
      expect(attempt).toMatchObject({
        status: 'settled',
        settlementKind: 'outcome',
        allocationRef: TEST_ALLOCATION_REF,
      });
      expect(authority.waitForOutcome(attempt!.executionAttemptId)).toBeUndefined();
    } finally {
      offDispatch();
    }
  });

  it('cleans up the waiter when pending abandonment itself rejects', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const abandonError = new Error('attempt storage unavailable');
    vi.spyOn(repository, 'abandonPendingAttempt').mockRejectedValue(abandonError);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    let executionAttemptId: string | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, (ctx) => {
      executionAttemptId = ctx.payload.executionAttemptId;
      throw new Error('dispatch acknowledgement lost');
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        authority,
      });

      let thrown: unknown;
      try {
        await runner!.run(makeWorkerConfig(), new AbortController().signal);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      if (!(thrown instanceof AggregateError)) throw new Error('expected dispatch failure to preserve both causes');
      expect(thrown.errors).toHaveLength(2);
      expect(thrown.errors[0]).toBeInstanceOf(Error);
      expect(thrown.errors[1]).toBe(abandonError);
      expect(authority.waitForOutcome(executionAttemptId!)).toBeUndefined();
    } finally {
      offDispatch();
    }
  });

  it('does not abandon an attempt when the outcome fails after dispatch acknowledgement', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const offDispatch = bus.on(WorkerSubjects.dispatch, (ctx) => {
      ctx.setResult({
        executionAttemptId: ctx.payload.executionAttemptId,
        allocationRef: TEST_ALLOCATION_REF,
      });
      queueMicrotask(() => authority.settleOutcome(ctx.payload.executionAttemptId, { kind: 'fenced' }));
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        authority,
      });

      await expect(runner!.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow();

      const [attempt] = repository.attempts.values();
      expect(attempt).toMatchObject({
        executionId: 'wfx-1',
        status: 'pending',
        settlementKind: null,
      });
      expect(authority.waitForOutcome(attempt!.executionAttemptId)).toBeUndefined();
    } finally {
      offDispatch();
    }
  });

  it('creates an attempt before dispatch and includes executionAttemptId in the request', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let capturedAttemptId: string | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      capturedAttemptId = ctx.payload.executionAttemptId;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      // Simulate worker outcome commitment and post-convergence settlement.
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        authority,
      });
      expect(runner).toBeDefined();

      const completion = await runner!.run(makeWorkerConfig(), new AbortController().signal);

      expect(capturedAttemptId).toBeTruthy();
      expect(completion.state).toBe('authority-committed');
      expect(completion.result.status).toBe('completed');
    } finally {
      offDispatch();
    }
  });

  it('preserves owner metadata and forwards per-dispatch resume input and contributions', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let capturedMetadata: Record<string, unknown> | undefined;
    let capturedManifest: unknown;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      capturedMetadata = ctx.payload.metadata;
      capturedManifest = ctx.payload.manifest;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        dispatchMetadata: { poolId: 'pool-1', resume: false },
        authority,
      });

      await runner!.run(
        makeWorkerConfig(),
        new AbortController().signal,
        { contributionRefs: [] },
        {
          dispatchMetadata: { resume: true },
        },
      );

      expect(capturedMetadata).toEqual({ poolId: 'pool-1', resume: true });
      expect(capturedManifest).toEqual({ contributionRefs: [] });
    } finally {
      offDispatch();
    }
  });

  it('routes through dispatch and carries full requirements when only recoverableAllocation is set', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { recoverableAllocation: true },
        authority,
      });
      expect(runner).toBeDefined();

      const completion = await runner!.run(makeWorkerConfig(), new AbortController().signal);
      expect(completion.state).toBe('authority-committed');
      expect(capturedRequirements).toEqual({ recoverableAllocation: true });
    } finally {
      offDispatch();
    }
  });

  it('routes through dispatch and carries full requirements when only materializationModes is set', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: { materializationModes: ['workspace-snapshot'] },
        authority,
      });
      expect(runner).toBeDefined();

      const completion = await runner!.run(makeWorkerConfig(), new AbortController().signal);
      expect(completion.state).toBe('authority-committed');
      expect(capturedRequirements).toEqual({
        materializationModes: ['workspace-snapshot'],
      });
    } finally {
      offDispatch();
    }
  });

  it('forwards capability requirements in the bus request', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerDispatchRunner({
        bus,
        requirements: {
          customCapabilities: ['workflow.remote', 'workflow.github-actions'],
        },
        authority,
      });

      await runner!.run(makeWorkerConfig(), new AbortController().signal);

      expect(capturedRequirements).toEqual({
        customCapabilities: ['workflow.remote', 'workflow.github-actions'],
      });
    } finally {
      offDispatch();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// launchDefinitionExecutionTask – requirements threading
// ─────────────────────────────────────────────────────────────

describe('launchDefinitionExecutionTask requirements threading', () => {
  it('routes through Worker dispatch when definition declares customCapabilities', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNamespace);
    bus.registerNamespace(WorkflowStorageNamespace);

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    let dispatchCalled = false;
    const offOwner = bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
      ctx.setResult({
        execution: createWorkflowExecution({
          id: 'wfx-dispatch-req',
          workflowId: 'workflow-with-req',
          status: dispatchCalled ? 'completed' : 'running',
        }),
      });
    });
    const finalizerDeps = {
      bus,
      activeExecutions: new Map(),
      shellAbortControllers: new Map(),
      activeRunnerSteps: new Map(),
      durableLifecycleTransitions: new Map(),
      lifecyclePublications: new Map(),
      publishingLifecycleExecutions: new Set<string>(),
    };
    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerSubjects.dispatch, async (ctx) => {
      dispatchCalled = true;
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      // Simulate outcome committed and settled by the worker.
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        authority.canonicalizeOutcome(result),
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    const fallbackRunner = vi.fn();
    const deps: StartExecutionDeps = {
      bus,
      config: {
        stepCooldownMs: 0,
        stepTimeoutMs: 10_000,
        cancelTimeoutMs: 5_000,
        busUrl: 'ws://localhost:0',
        busAuth: { kind: 'none' },
        platformDefaults: { cwd: '/tmp', env: {} },
      },
      activeExecutions: new Map(),
      executionTasks: new Map(),
      workflowRunner: undefined,
      materializationSpecResolvers: new Set(),
      buildRunContext: vi.fn(),
      buildRunnerTaskDeps: (runner) => ({
        workflowRunner: runner,
        workflowAbortControllers: new Map(),
        executionTasks: new Map(),
        activeExecutions: new Map(),
        buildFinalizerDeps: () => finalizerDeps,
        config: deps.config,
      }),
      buildFinalizerDeps: () => finalizerDeps,
      resolveExecutionWorkspaceRoot: vi.fn(),
      runExecution: fallbackRunner,
      executionAttemptAuthority: authority,
    };

    const params: DefinitionRunnerTaskParams = {
      executionId: 'wfx-dispatch-req',
      workflowId: 'workflow-with-req',
      workflow: {
        id: 'workflow-with-req',
        name: 'test-workflow',
        root: { id: 'root', type: 'sequence', nodes: [] },
        scope: { type: 'global' },
        requirements: {
          customCapabilities: ['workflow.remote-execution'],
        },
      },
      source: { kind: 'definition', workflowId: 'workflow-with-req' },
      coordinatorSessionId: 'session-1',
      sanitizedTriggerPayload: {},
      boundInputs: {},
      boundConfig: {},
      scope: { type: 'global' },
      terminalAuthority: 'authority',
    };

    try {
      await launchDefinitionExecutionTask(deps, params);

      expect(dispatchCalled).toBe(true);
      expect(capturedRequirements).toEqual({
        customCapabilities: ['workflow.remote-execution'],
      });
      expect(fallbackRunner).not.toHaveBeenCalled();
    } finally {
      offOwner();
      offDispatch();
    }
  });

  it('falls through to in-process runner when definition has no requirements', async () => {
    const bus = createBusInstance();

    const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });

    const fallbackRunner = vi.fn().mockResolvedValue(undefined);
    const executionTasks = new Map<string, Promise<void>>();
    const deps: StartExecutionDeps = {
      bus,
      config: {
        stepCooldownMs: 0,
        stepTimeoutMs: 10_000,
        cancelTimeoutMs: 5_000,
        busUrl: 'ws://localhost:0',
        busAuth: { kind: 'none' },
        platformDefaults: { cwd: '/tmp', env: {} },
      },
      activeExecutions: new Map(),
      executionTasks,
      workflowRunner: undefined,
      materializationSpecResolvers: new Set(),
      buildRunContext: vi.fn(),
      buildRunnerTaskDeps: vi.fn() as never,
      buildFinalizerDeps: vi.fn() as never,
      resolveExecutionWorkspaceRoot: vi.fn(),
      runExecution: fallbackRunner,
      executionAttemptAuthority: authority,
    };

    const params: DefinitionRunnerTaskParams = {
      executionId: 'wfx-no-req',
      workflowId: 'workflow-no-req',
      workflow: {
        id: 'workflow-no-req',
        name: 'test-workflow-no-req',
        root: { id: 'root', type: 'sequence', nodes: [] },
        scope: { type: 'global' },
        // No requirements — should NOT route through Worker dispatch.
      },
      source: { kind: 'definition', workflowId: 'workflow-no-req' },
      coordinatorSessionId: 'session-2',
      sanitizedTriggerPayload: {},
      boundInputs: {},
      boundConfig: {},
      scope: { type: 'global' },
    };

    await launchDefinitionExecutionTask(deps, params);

    expect(fallbackRunner).toHaveBeenCalledWith('wfx-no-req');
  });
});
