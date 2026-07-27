import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type {
  WorkflowWorkerConfig,
  IWorkflowRunner,
  WorkflowFrameState,
  WorkflowGateInstance,
  WorkflowRunContext,
  WorkflowRunnerCompletion,
  WorkflowRunResult,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build a paused run result for a given execution.
 * @param executionId - Execution identifier.
 * @param workflowId - Workflow definition identifier.
 * @param gateId - Gate node ID at which execution paused.
 * @param frameId - Frame ID of the suspended gate instance.
 * @returns A paused WorkflowRunResult.
 */
function makePausedRunResult(
  executionId: string,
  workflowId: string,
  gateId: string,
  frameId: string,
): WorkflowRunResult {
  return { executionId, workflowId, status: 'paused', pausedAtGateId: gateId, pausedAtFrameId: frameId };
}

/**
 * Start a workflow through the executor bus subject and return the execution ID.
 * @param workflowId - Workflow definition to start.
 * @returns The started execution ID.
 */
async function startWorkflowThroughExecutor(workflowId: string): Promise<string> {
  const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId });
  return executionId;
}

/**
 * Check durable execution state for any terminal or parked status.
 * @param executionId - Execution to inspect.
 * @returns True when the execution has reached a settled state.
 */
async function isExecutionSettled(executionId: string): Promise<boolean> {
  const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
  return (
    execution?.status === 'completed' ||
    execution?.status === 'failed' ||
    execution?.status === 'cancelled' ||
    execution?.status === 'paused'
  );
}

/**
 * Wait for the execution task to settle by observing any terminal or paused
 * lifecycle event for the given execution ID.
 * @param executionId - Execution to wait for.
 * @returns A promise that resolves when the execution has reached a settled state.
 */
async function waitForExecutionTaskToSettle(executionId: string): Promise<void> {
  if (await isExecutionSettled(executionId)) {
    return;
  }

  return new Promise<void>((resolve) => {
    const offs: Array<() => void> = [];
    const onSettle = (id: string): void => {
      if (id !== executionId) return;
      for (const off of offs) off();
      resolve();
    };

    // Register one handler per distinct terminal/paused subject so each is
    // typed correctly and `ctx.payload.executionId` is always accessible.
    offs.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        onSettle(ctx.payload.executionId);
      }),
    );
    offs.push(
      MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        onSettle(ctx.payload.executionId);
      }),
    );
    offs.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
        onSettle(ctx.payload.executionId);
      }),
    );
    offs.push(
      MakaioBus.on(WorkflowSubjects.execution.paused, (ctx) => {
        onSettle(ctx.payload.executionId);
      }),
    );
    void isExecutionSettled(executionId).then((settled) => {
      if (settled) {
        onSettle(executionId);
      }
    });
  });
}

/**
 * Seed a paused execution and a waiting gate instance in storage.
 *
 * This mirrors the state that would exist after an exit-and-redispatch provider
 * parks an execution: the execution row has `status: 'paused'` and a gate
 * instance with `status: 'waiting'` exists for the given node/frame.
 * @param workflowId - Workflow definition identifier.
 * @param executionId - Execution identifier.
 * @param gateId - Gate node ID.
 * @param frameId - Gate frame ID.
 * @param schema - Persisted gate resume schema.
 * @param options - Optional seeded storage controls.
 * @returns The seeded gate instance.
 */
async function seedPausedExecutionAndGate(
  workflowId: string,
  executionId: string,
  gateId: string,
  frameId: string,
  schema: WorkflowGateInstance['schema'] = {},
  options: {
    readonly materializationSpec?: NonNullable<WorkflowRunContext['materializationSpec']>;
    readonly seedResumeFrame?: boolean;
  } = {},
): Promise<WorkflowGateInstance> {
  const execution = createWorkflowExecution({
    id: executionId,
    workflowId,
    status: 'paused',
    completedAt: undefined,
  });
  await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

  // Persist a run context so resumePausedExecution can look it up.
  const workflow = createWorkflowDefinition({ id: workflowId });
  const source =
    options.materializationSpec === undefined
      ? ({ kind: 'definition', workflowId } as const)
      : ({ kind: 'path', path: options.materializationSpec.sourcePath } as const);
  const runContext: WorkflowRunContext = {
    executionId,
    workflowId,
    source,
    definitionSnapshot: workflow,
    workerManifest: { contributionRefs: [] },
    inputs: {},
    config: {},
    scope: { type: 'global' },
    triggerPayload: {},
    coordinatorSessionId: 'session-test',
    cancelSubject: `workflow.${executionId}.cancel`,
    env: {},
    createdAt: Date.now(),
    suspensionStrategy: 'exit-and-redispatch',
    ...(options.materializationSpec !== undefined ? { materializationSpec: options.materializationSpec } : {}),
  };
  await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

  if (options.seedResumeFrame !== false) {
    const resumeFrame: WorkflowFrameState = {
      frameId: `frame-${executionId}-root`,
      nodeId: workflow.root.id,
      nodeType: 'sequence',
      path: [`frame-${executionId}-root`],
      status: 'running',
      attempt: 0,
      startedAt: Date.now(),
    };
    await MakaioBus.request(WorkflowStorageSubjects.setFrame, { executionId, frame: resumeFrame });
  }

  const gate: WorkflowGateInstance = {
    executionId,
    nodeId: gateId,
    frameId,
    schema,
    status: 'waiting',
    autoAction: 'reject',
    timeoutMs: null,
    createdAt: Date.now(),
  };
  await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, { gate });

  return gate;
}

// ─────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────

describe('WorkflowExecutor — paused gate integration', () => {
  let setup: WorkflowExecutorTestSetup;

  beforeEach(async () => {
    // Re-initialize for each test because the runner is injected per-test.
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await teardownWorkflowExecutorTest(setup);
  });

  it('parks a runner result without terminalizing the execution', async () => {
    const workflowId = `wf-paused-${Math.random().toString(36).slice(2)}`;
    const definition = createWorkflowDefinition({ id: workflowId });

    // The runner receives the real executionId via config.executionId, so we
    // construct the paused result dynamically from the config.
    const stubRunner: IWorkflowRunner = {
      run: vi.fn(
        (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> =>
          Promise.resolve({
            state: 'uncommitted',
            result: makePausedRunResult(config.executionId, config.workflowId, 'gate-approve', 'frame-gate-1'),
          }),
      ),
    };

    // Persist the workflow definition so startExecution can look it up.
    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    const pausedEvents: Array<{ executionId: string }> = [];
    const completedEvents: Array<{ executionId: string }> = [];

    const offPaused = MakaioBus.on(WorkflowSubjects.execution.paused, (ctx) => {
      pausedEvents.push({ executionId: ctx.payload.executionId });
    });
    const offCompleted = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
      completedEvents.push({ executionId: ctx.payload.executionId });
    });

    try {
      const executionId = await startWorkflowThroughExecutor(workflowId);
      await waitForExecutionTaskToSettle(executionId);

      // 1. The execution status must be 'paused' — not completed/failed.
      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('paused');
      expect(execution?.completedAt).toBeUndefined();

      // 2. execution.paused was emitted.
      expect(pausedEvents.some((e) => e.executionId === executionId)).toBe(true);

      // 3. execution.completed was NOT emitted.
      expect(completedEvents.some((e) => e.executionId === executionId)).toBe(false);
    } finally {
      offPaused();
      offCompleted();
    }
  });

  it('serializes cancellation after a pause CAS before paused projection', async () => {
    const workflowId = `wf-pause-cancel-race-${Math.random().toString(36).slice(2)}`;
    const definition = createWorkflowDefinition({ id: workflowId });
    const releaseRunner = Promise.withResolvers<WorkflowRunnerCompletion>();
    const pauseRequestReached = Promise.withResolvers<void>();
    const releasePauseRequest = Promise.withResolvers<void>();
    const pauseRequestFinished = Promise.withResolvers<void>();
    const stubRunner: IWorkflowRunner = {
      run: vi.fn(() => releaseRunner.promise),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    const pausedEvents: string[] = [];
    const lifecycleEvents: string[] = [];
    const offPaused = MakaioBus.on(WorkflowSubjects.execution.paused, (ctx) => {
      pausedEvents.push(ctx.payload.executionId);
      lifecycleEvents.push('paused');
    });
    const offCancelled = MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
      lifecycleEvents.push('cancelled');
    });
    const delayPauseTransition = MakaioBus.on(
      WorkflowStorageSubjects.pauseRunningExecution,
      async (ctx) => {
        await ctx.next();
        pauseRequestReached.resolve();
        await releasePauseRequest.promise;
        pauseRequestFinished.resolve();
      },
      { priority: 100 },
    );

    try {
      const executionId = await startWorkflowThroughExecutor(workflowId);
      releaseRunner.resolve({
        state: 'uncommitted',
        result: makePausedRunResult(executionId, workflowId, 'gate-approve', 'frame-gate-1'),
      });
      await pauseRequestReached.promise;

      const cancellation = MakaioBus.request(WorkflowSubjects.cancel, {
        executionId,
        reason: 'cancel follows pause projection',
      });
      await expect(MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId })).resolves.toEqual(
        expect.objectContaining({ execution: expect.objectContaining({ status: 'paused' }) }),
      );

      releasePauseRequest.resolve();
      await pauseRequestFinished.promise;
      await expect(cancellation).resolves.toEqual({ cancelled: true });

      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('cancelled');
      expect(pausedEvents).toEqual([executionId]);
      expect(lifecycleEvents).toEqual(['paused', 'cancelled']);
    } finally {
      delayPauseTransition();
      offPaused();
      offCancelled();
    }
  });

  it('allows a paused lifecycle handler to await reentrant cancellation', async () => {
    const workflowId = `wf-pause-reentrant-cancel-${Math.random().toString(36).slice(2)}`;
    const definition = createWorkflowDefinition({ id: workflowId });
    const releaseRunner = Promise.withResolvers<WorkflowRunnerCompletion>();
    const stubRunner: IWorkflowRunner = { run: vi.fn(() => releaseRunner.promise) };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    const cancellationFinished = Promise.withResolvers<void>();
    const offPaused = MakaioBus.on(WorkflowSubjects.execution.paused, async (ctx) => {
      await expect(
        MakaioBus.request(WorkflowSubjects.cancel, {
          executionId: ctx.payload.executionId,
          reason: 'cancelled by paused handler',
        }),
      ).resolves.toEqual({ cancelled: true });
      cancellationFinished.resolve();
    });

    try {
      const executionId = await startWorkflowThroughExecutor(workflowId);
      releaseRunner.resolve({
        state: 'uncommitted',
        result: makePausedRunResult(executionId, workflowId, 'gate-approve', 'frame-gate-1'),
      });
      await cancellationFinished.promise;
      await vi.waitFor(async () => {
        const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
        expect(execution?.status).toBe('cancelled');
      });
    } finally {
      offPaused();
    }
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
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    const holdCancelledEvent = MakaioBus.on(WorkflowSubjects.execution.cancelled, async () => {
      cancellationPersisted.resolve();
      await releaseCancellationPublication.promise;
    });

    try {
      const executionId = await startWorkflowThroughExecutor(workflowId);
      const cancellation = MakaioBus.request(WorkflowSubjects.cancel, { executionId, reason: 'race winner' });
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
      await waitForExecutionTaskToSettle(executionId);

      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution?.status).toBe('cancelled');
    } finally {
      releaseCancellationPublication.resolve();
      holdCancelledEvent();
    }
  });

  it('cancels a parked paused gate execution without active runtime ownership', async () => {
    const workflowId = `wf-paused-cancel-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-paused-cancel-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-paused-cancel-1';

    setup = await setupWorkflowExecutorTest();
    await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);

    const cancelledEvents: Array<{ executionId: string; workflowId: string; reason?: string }> = [];
    const gateResolvedEvents: Array<{ executionId: string; frameId: string; source: 'cancelled' }> = [];
    const offCancelled = MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
      cancelledEvents.push({
        executionId: ctx.payload.executionId,
        workflowId: ctx.payload.workflowId,
        reason: ctx.payload.reason,
      });
    });
    const offGateResolved = MakaioBus.on(
      WorkflowSubjects.gate.resolved,
      (ctx) => {
        gateResolvedEvents.push({
          executionId: ctx.payload.executionId,
          frameId: ctx.payload.frameId,
          source: 'cancelled',
        });
      },
      { filter: { source: 'cancelled' } },
    );

    try {
      const cancelResult = await MakaioBus.request(WorkflowSubjects.cancel, {
        executionId,
        reason: 'stop parked gate',
      });

      const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
      const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
        executionId,
        nodeId: gateId,
        frameId,
      });
      const response = await MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId,
        gateId,
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved' },
      });

      expect(cancelResult.cancelled).toBe(true);
      expect(execution?.status).toBe('cancelled');
      expect(execution?.completedAt).toEqual(expect.any(Number));
      expect(gate?.status).toBe('cancelled');
      expect(gate?.resolvedAt).toEqual(expect.any(Number));
      expect(response.accepted).toBe(false);
      expect(cancelledEvents).toEqual([{ executionId, workflowId, reason: 'stop parked gate' }]);
      expect(gateResolvedEvents).toEqual([{ executionId, frameId, source: 'cancelled' }]);
    } finally {
      offCancelled();
      offGateResolved();
    }
  });

  it('returns false when cancelling an unknown execution', async () => {
    setup = await setupWorkflowExecutorTest();

    const cancelResult = await MakaioBus.request(WorkflowSubjects.cancel, {
      executionId: 'missing-paused-cancel',
      reason: 'not running',
    });

    expect(cancelResult).toEqual({ cancelled: false });
  });

  it('accepts a paused gate response and dispatches resume through the stored run context', async () => {
    const workflowId = `wf-resume-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-resume-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-approve-1';

    const materializationSpec = {
      kind: 'workspace-snapshot' as const,
      snapshotId: 'snapshot-resume',
      digest: 'sha256-resume',
      sourcePath: 'workflows/resume.ts',
    };
    const runnerCalls: WorkflowWorkerConfig[] = [];
    const stubRunner: IWorkflowRunner = {
      run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
        runnerCalls.push(config);
        return Promise.resolve({
          state: 'uncommitted',
          result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
        });
      }),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });

    // Seed storage with a paused execution and a waiting gate.
    await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId, {}, { materializationSpec });

    // Send a gate.respond through the bus — the executor's low-priority fallback
    // handler should accept it.
    const { accepted } = await MakaioBus.request(WorkflowSubjects.gate.respond, {
      executionId,
      gateId,
      frameId,
      action: 'approve',
      resumeData: { decision: 'approved' },
    });

    expect(accepted).toBe(true);

    // The gate instance must be updated to 'resumed'.
    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });
    expect(gate?.status).toBe('resumed');

    // Resume must forward the complete portable workspace identity to the runner.
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      executionId,
      source: { kind: 'path', path: materializationSpec.sourcePath },
      materializationSpec,
    });
  });

  it('accepts only one concurrent paused gate response for the same frame', async () => {
    const workflowId = `wf-resume-atomic-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-resume-atomic-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-atomic-1';

    const runnerCalls: Array<{ executionId: string }> = [];
    const releaseRunner = Promise.withResolvers<WorkflowRunnerCompletion>();
    const stubRunner: IWorkflowRunner = {
      run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
        runnerCalls.push({ executionId: config.executionId });
        return releaseRunner.promise;
      }),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);

    const responses = await Promise.all([
      MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId,
        gateId,
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved-a' },
      }),
      MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId,
        gateId,
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved-b' },
      }),
    ]);

    expect(responses.map((response) => response.accepted).sort()).toEqual([false, true]);
    expect(runnerCalls).toEqual([{ executionId }]);

    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });
    expect(gate?.status).toBe('resumed');
    expect([{ decision: 'approved-a' }, { decision: 'approved-b' }]).toContainEqual(gate?.resumeData);

    releaseRunner.resolve({ state: 'uncommitted', result: { executionId, workflowId, status: 'completed' } });
    await vi.waitFor(() => {
      expect(stubRunner.run).toHaveBeenCalledTimes(1);
    });
  });

  it('restores a waiting paused gate when manual resume dispatch cannot launch', async () => {
    const workflowId = `wf-resume-launch-fails-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-resume-launch-fails-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-resume-launch-fails-1';

    const stubRunner: IWorkflowRunner = {
      run: vi.fn(
        (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> =>
          Promise.resolve({
            state: 'uncommitted',
            result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
          }),
      ),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    const seededGate = await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);
    const failRunningTransition = MakaioBus.on(
      WorkflowStorageSubjects.setExecution,
      (ctx) => {
        if (ctx.payload.execution.id === executionId && ctx.payload.execution.status === 'running') {
          throw new Error('running transition unavailable');
        }
      },
      { priority: 100 },
    );

    try {
      await expect(
        MakaioBus.request(WorkflowSubjects.gate.respond, {
          executionId,
          gateId,
          frameId,
          action: 'approve',
          resumeData: { decision: 'approved' },
        }),
      ).rejects.toThrow('running transition unavailable');
    } finally {
      failRunningTransition();
    }

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });

    expect(execution?.status).toBe('paused');
    expect(gate).toEqual(seededGate);
    expect(stubRunner.run).not.toHaveBeenCalled();
  });

  it('does not dispatch the same paused execution twice when timeout and manual response race', async () => {
    vi.useFakeTimers();

    try {
      const workflowId = `wf-resume-race-${Math.random().toString(36).slice(2)}`;
      const executionId = `wfx-resume-race-${Math.random().toString(36).slice(2)}`;
      const gateId = 'gate-race';
      const frameId = 'frame-gate-race-1';

      const runnerCalls: Array<{ executionId: string }> = [];
      const releaseRunner = Promise.withResolvers<WorkflowRunnerCompletion>();
      const stubRunner: IWorkflowRunner = {
        run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
          runnerCalls.push({ executionId: config.executionId });
          return releaseRunner.promise;
        }),
      };

      setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
      await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);

      await MakaioBus.emit(WorkflowSubjects.gate.suspended, {
        executionId,
        nodeId: gateId,
        frameId,
        schema: {},
        prompt: 'Approve before timeout?',
        autoAction: 'reject',
        timeoutMs: 1000,
        openedAt: Date.now(),
      });

      await Promise.all([
        MakaioBus.request(WorkflowSubjects.gate.respond, {
          executionId,
          gateId,
          frameId,
          action: 'approve',
          resumeData: { decision: 'approved' },
        }),
        vi.advanceTimersByTimeAsync(1001),
      ]);

      expect(runnerCalls).toEqual([{ executionId }]);
      releaseRunner.resolve({ state: 'uncommitted', result: { executionId, workflowId, status: 'completed' } });
      await vi.waitFor(() => {
        expect(stubRunner.run).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails paused gate response dispatch when durable resume frames are missing', async () => {
    const workflowId = `wf-missing-resume-frames-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-missing-resume-frames-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-missing-frames';
    const frameId = 'frame-gate-missing-frames-1';

    const stubRunner: IWorkflowRunner = {
      run: vi.fn(
        (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> =>
          Promise.resolve({
            state: 'uncommitted',
            result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
          }),
      ),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
    await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId, {}, { seedResumeFrame: false });

    await expect(
      MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId,
        gateId,
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved' },
      }),
    ).rejects.toThrow(`[WorkflowExecutor] Missing resume frames for paused execution: ${executionId}`);

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe('paused');
    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });
    expect(gate?.status).toBe('waiting');
    expect(stubRunner.run).not.toHaveBeenCalled();
  });

  it('rejects paused gate resume data that does not match the persisted gate schema', async () => {
    const workflowId = `wf-invalid-resume-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-invalid-resume-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-invalid-resume-1';

    const stubRunner: IWorkflowRunner = {
      run: vi.fn(
        (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> =>
          Promise.resolve({
            state: 'uncommitted',
            result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
          }),
      ),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });

    const gate = await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId, {
      type: 'object',
      required: ['decision'],
      properties: { decision: { const: 'approved' } },
      additionalProperties: false,
    });

    const { accepted } = await MakaioBus.request(WorkflowSubjects.gate.respond, {
      executionId,
      gateId,
      frameId,
      action: 'approve',
      resumeData: { decision: 'denied' },
    });

    expect(accepted).toBe(false);

    const { gate: persistedGate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });
    expect(persistedGate).toEqual(gate);
    expect(stubRunner.run).not.toHaveBeenCalled();
  });

  it('accepts frameId-less paused gate responses when the gate node is unique', async () => {
    const workflowId = `wf-frame-optional-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-frame-optional-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-frame-optional-1';

    const runnerCalls: Array<{ executionId: string }> = [];
    const stubRunner: IWorkflowRunner = {
      run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
        runnerCalls.push({ executionId: config.executionId });
        return Promise.resolve({
          state: 'uncommitted',
          result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
        });
      }),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });

    await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);

    const { accepted } = await MakaioBus.request(WorkflowSubjects.gate.respond, {
      executionId,
      gateId,
      action: 'approve',
      resumeData: { decision: 'approved' },
    });

    expect(accepted).toBe(true);

    const { gate: persistedGate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId,
      nodeId: gateId,
      frameId,
    });
    expect(persistedGate?.status).toBe('resumed');
    expect(runnerCalls).toEqual([{ executionId }]);
  });

  it('rejects frameId-less paused gate responses when the gate node is ambiguous', async () => {
    const workflowId = `wf-frame-ambiguous-${Math.random().toString(36).slice(2)}`;
    const executionId = `wfx-frame-ambiguous-${Math.random().toString(36).slice(2)}`;
    const gateId = 'gate-approve';
    const frameId = 'frame-gate-ambiguous-1';
    const secondFrameId = 'frame-gate-ambiguous-2';

    const stubRunner: IWorkflowRunner = {
      run: vi.fn(
        (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> =>
          Promise.resolve({
            state: 'uncommitted',
            result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
          }),
      ),
    };

    setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });

    const firstGate = await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);
    const secondGate: WorkflowGateInstance = { ...firstGate, frameId: secondFrameId, createdAt: Date.now() };
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, { gate: secondGate });

    const { accepted } = await MakaioBus.request(WorkflowSubjects.gate.respond, {
      executionId,
      gateId,
      action: 'approve',
      resumeData: { decision: 'approved' },
    });

    expect(accepted).toBe(false);
    const { gates } = await MakaioBus.request(WorkflowStorageSubjects.listGateInstances, { executionId });
    expect(gates.filter((gate) => gate.nodeId === gateId).map((gate) => gate.status)).toEqual(['waiting', 'waiting']);
    expect(stubRunner.run).not.toHaveBeenCalled();
  });

  it('redispatches a paused gate when its suspended timeout expires', async () => {
    vi.useFakeTimers();

    try {
      const workflowId = `wf-timeout-resume-${Math.random().toString(36).slice(2)}`;
      const executionId = `wfx-timeout-resume-${Math.random().toString(36).slice(2)}`;
      const gateId = 'gate-timeout';
      const frameId = 'frame-gate-timeout-1';

      const runnerCalls: Array<{ executionId: string }> = [];
      const stubRunner: IWorkflowRunner = {
        run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
          runnerCalls.push({ executionId: config.executionId });
          return Promise.resolve({
            state: 'uncommitted',
            result: {
              executionId: config.executionId,
              workflowId: config.workflowId,
              status: 'completed',
            },
          });
        }),
      };

      setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner });
      await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);

      await MakaioBus.emit(WorkflowSubjects.gate.suspended, {
        executionId,
        nodeId: gateId,
        frameId,
        schema: {},
        prompt: 'Approve before timeout?',
        autoAction: 'reject',
        timeoutMs: 1000,
        openedAt: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(1001);

      await vi.waitFor(() => {
        expect(runnerCalls.some((call) => call.executionId === executionId)).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rehydrates a parked gate timeout when the executor starts after the gate was suspended', async () => {
    vi.useFakeTimers();

    try {
      const workflowId = `wf-timeout-rehydrate-${Math.random().toString(36).slice(2)}`;
      const executionId = `wfx-timeout-rehydrate-${Math.random().toString(36).slice(2)}`;
      const gateId = 'gate-timeout-rehydrate';
      const frameId = 'frame-gate-timeout-rehydrate-1';

      const runnerCalls: Array<{ executionId: string }> = [];
      const stubRunner: IWorkflowRunner = {
        run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
          runnerCalls.push({ executionId: config.executionId });
          return Promise.resolve({
            state: 'uncommitted',
            result: {
              executionId: config.executionId,
              workflowId: config.workflowId,
              status: 'completed',
            },
          });
        }),
      };

      setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner, initExecutor: false });
      const gate = await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);
      await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: { ...gate, autoAction: 'approve', timeoutMs: 1000 },
      });

      await setup.workflowExecutor.init();
      await vi.advanceTimersByTimeAsync(1001);

      await vi.waitFor(() => {
        expect(runnerCalls.some((call) => call.executionId === executionId)).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a rehydrated parked gate timeout when the gate receives a manual response', async () => {
    vi.useFakeTimers();

    try {
      const workflowId = `wf-timeout-clear-${Math.random().toString(36).slice(2)}`;
      const executionId = `wfx-timeout-clear-${Math.random().toString(36).slice(2)}`;
      const gateId = 'gate-timeout-clear';
      const frameId = 'frame-gate-timeout-clear-1';

      const runnerCalls: Array<{ executionId: string }> = [];
      const stubRunner: IWorkflowRunner = {
        run: vi.fn((config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
          runnerCalls.push({ executionId: config.executionId });
          return Promise.resolve({
            state: 'uncommitted',
            result: {
              executionId: config.executionId,
              workflowId: config.workflowId,
              status: 'completed',
            },
          });
        }),
      };

      setup = await setupWorkflowExecutorTest({ workflowRunner: stubRunner, initExecutor: false });
      const gate = await seedPausedExecutionAndGate(workflowId, executionId, gateId, frameId);
      await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
        gate: { ...gate, autoAction: 'reject', timeoutMs: 1000 },
      });

      await setup.workflowExecutor.init();
      const response = await MakaioBus.request(WorkflowSubjects.gate.respond, {
        executionId,
        gateId,
        frameId,
        action: 'approve',
        resumeData: { decision: 'approved' },
      });

      expect(response).toEqual({ accepted: true });
      await vi.waitFor(() => {
        expect(runnerCalls).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(1001);
      await Promise.resolve();

      expect(runnerCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
