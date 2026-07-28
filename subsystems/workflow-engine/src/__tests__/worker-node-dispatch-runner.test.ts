import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNodeNamespace, WorkerNodeSubjects } from '@makaio/contracts';
import type { ProviderAllocationRef, WorkflowRunResult, WorkerNodeRequirements } from '@makaio/contracts';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { hasWorkerNodeDispatchRequirements, createWorkerNodeDispatchRunner } from '../worker-node-dispatch-runner.js';
import { launchDefinitionExecutionTask } from '../workflow-definition-dispatch.js';
import type { StartExecutionDeps } from '../workflow-execution-start.js';
import type { DefinitionRunnerTaskParams } from '../workflow-runner-tasks.js';
import { createInMemoryAttemptRepository } from './fixtures/in-memory-attempt-repository.js';

function makeWorkerConfig(): Parameters<NonNullable<ReturnType<typeof createWorkerNodeDispatchRunner>>['run']>[0] {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
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

describe('hasWorkerNodeDispatchRequirements', () => {
  it('returns false when no requirements are present', () => {
    expect(hasWorkerNodeDispatchRequirements(undefined)).toBe(false);
  });

  it('returns false when customCapabilities are empty', () => {
    const requirements: WorkerNodeRequirements = {
      customCapabilities: [],
    };
    expect(hasWorkerNodeDispatchRequirements(requirements)).toBe(false);
  });

  it('returns false for an empty requirements object', () => {
    expect(hasWorkerNodeDispatchRequirements({})).toBe(false);
  });

  it('returns true when customCapabilities are present', () => {
    const requirements: WorkerNodeRequirements = {
      customCapabilities: ['workflow.remote'],
    };
    expect(hasWorkerNodeDispatchRequirements(requirements)).toBe(true);
  });

  it('returns true when only recoverableAllocation is set', () => {
    expect(hasWorkerNodeDispatchRequirements({ recoverableAllocation: true })).toBe(true);
  });

  it('returns true when only materializationModes are set', () => {
    expect(
      hasWorkerNodeDispatchRequirements({
        materializationModes: ['workspace-snapshot'],
      }),
    ).toBe(true);
  });

  it('returns false for materializationModes with an empty array', () => {
    expect(hasWorkerNodeDispatchRequirements({ materializationModes: [] })).toBe(false);
  });

  it('returns true when only persistentStorage is set', () => {
    expect(hasWorkerNodeDispatchRequirements({ persistentStorage: true })).toBe(true);
  });

  it('returns true when only maxRuntimeMs is set', () => {
    expect(hasWorkerNodeDispatchRequirements({ maxRuntimeMs: 60_000 })).toBe(true);
  });
});

describe('createWorkerNodeDispatchRunner', () => {
  it('returns undefined when no capability constraint exists', () => {
    const bus = createBusInstance();
    const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository());
    const runner = createWorkerNodeDispatchRunner({
      bus,
      requirements: undefined,
      authority,
    });
    expect(runner).toBeUndefined();
  });

  it('returns undefined when customCapabilities are empty', () => {
    const bus = createBusInstance();
    const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository());
    const runner = createWorkerNodeDispatchRunner({
      bus,
      requirements: { customCapabilities: [] },
      authority,
    });
    expect(runner).toBeUndefined();
  });

  it('abandons the durable pending attempt and removes its waiter when dispatch has no handler', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);
    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);
    const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);
    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);
    const localFailure = new Error('provider cleanup requires recovery');
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      await authority.beginProvisioning(ctx.payload.executionAttemptId, ctx.payload.config.executionId);
      authority.rejectAndDiscardWaiter(ctx.payload.executionAttemptId, localFailure);
      throw localFailure;
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);
    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      await authority.beginProvisioning(ctx.payload.executionAttemptId, ctx.payload.config.executionId);
      await authority.recordAllocation(ctx.payload.executionAttemptId, TEST_ALLOCATION_REF);
      queueMicrotask(async () => {
        const result: WorkflowRunResult = {
          executionId: ctx.payload.config.executionId,
          workflowId: ctx.payload.config.workflowId,
          status: 'completed',
        };
        const decision = await authority.commitOutcome(
          ctx.payload.executionAttemptId,
          ctx.payload.config.executionId,
          result,
        );
        authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      });
      throw new Error('dispatch acknowledgement lost');
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);
    const repository = createInMemoryAttemptRepository();
    const abandonError = new Error('attempt storage unavailable');
    vi.spyOn(repository, 'abandonPendingAttempt').mockRejectedValue(abandonError);
    const authority = new ExecutionAttemptAuthority(repository);
    let executionAttemptId: string | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, (ctx) => {
      executionAttemptId = ctx.payload.executionAttemptId;
      throw new Error('dispatch acknowledgement lost');
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);
    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, (ctx) => {
      ctx.setResult({
        executionAttemptId: ctx.payload.executionAttemptId,
        allocationRef: TEST_ALLOCATION_REF,
      });
      queueMicrotask(() => authority.settleOutcome(ctx.payload.executionAttemptId, { kind: 'fenced' }));
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let capturedAttemptId: string | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
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
        result,
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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

  it('forwards dispatch metadata in the bus request', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let capturedMetadata: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      capturedMetadata = ctx.payload.metadata;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        result,
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
        bus,
        requirements: { customCapabilities: ['workflow.remote'] },
        dispatchMetadata: { poolId: 'pool-1', resume: true },
        authority,
      });

      await runner!.run(makeWorkerConfig(), new AbortController().signal);

      expect(capturedMetadata).toEqual({ poolId: 'pool-1', resume: true });
    } finally {
      offDispatch();
    }
  });

  it('routes through dispatch and carries full requirements when only recoverableAllocation is set', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        result,
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        result,
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
      capturedRequirements = ctx.payload.requirements;
      const result: WorkflowRunResult = {
        executionId: ctx.payload.config.executionId,
        workflowId: ctx.payload.config.workflowId,
        status: 'completed',
      };
      const decision = await authority.commitOutcome(
        ctx.payload.executionAttemptId,
        ctx.payload.config.executionId,
        result,
      );
      authority.settleOutcome(ctx.payload.executionAttemptId, decision);
      ctx.setResult({ executionAttemptId: ctx.payload.executionAttemptId, allocationRef: TEST_ALLOCATION_REF });
    });

    try {
      const runner = createWorkerNodeDispatchRunner({
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
  it('routes through WorkerNode dispatch when definition declares customCapabilities', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

    let dispatchCalled = false;
    let capturedRequirements: Record<string, unknown> | undefined;
    const offDispatch = bus.on(WorkerNodeSubjects.dispatch, async (ctx) => {
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
        result,
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
        buildFinalizerDeps: vi.fn() as never,
        config: deps.config,
      }),
      buildFinalizerDeps: vi.fn() as never,
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
      offDispatch();
    }
  });

  it('falls through to in-process runner when definition has no requirements', async () => {
    const bus = createBusInstance();

    const repository = createInMemoryAttemptRepository();
    const authority = new ExecutionAttemptAuthority(repository);

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
        // No requirements — should NOT route through WorkerNode dispatch.
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
