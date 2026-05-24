import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { IStepRunner, StepRunConfig, StepRunResult, WorkflowDefinition } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowScheduler } from '../workflow-scheduler.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import type { ActiveExecution, ActiveRunnerStep, ExecutorConfig, WorkflowSchedulerDeps } from '../types.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

/**
 * A blocking step runner that records abort signals and allows external control.
 * Used to test cooperative and hard cancellation paths.
 */
class BlockingStepRunner implements IStepRunner {
  public readonly managesWorkflowLifecycle = true;
  public readonly abortedSteps: string[] = [];
  public readonly forceKilledSteps: string[] = [];

  private readonly pending = new Map<string, { resolve: (result: StepRunResult) => void; signal: AbortSignal }>();

  public async run(config: StepRunConfig, signal: AbortSignal): Promise<StepRunResult> {
    return new Promise<StepRunResult>((resolve) => {
      this.pending.set(config.stepId, { resolve, signal });
      signal.addEventListener('abort', () => {
        this.abortedSteps.push(config.stepId);
      });
    });
  }

  public async forceKill(_executionId: string, stepId: string): Promise<void> {
    this.forceKilledSteps.push(stepId);
    const entry = this.pending.get(stepId);
    if (entry) {
      this.pending.delete(stepId);
      entry.resolve({
        status: 'failed',
        error: 'Force killed',
        telemetry: { duration: 0 },
      });
    }
  }

  /**
   * Complete a pending step externally (for test setup).
   * @param stepId - Step identifier to complete.
   * @param result - Optional result to resolve with.
   */
  public complete(stepId: string, result?: StepRunResult): void {
    const entry = this.pending.get(stepId);
    if (entry) {
      this.pending.delete(stepId);
      entry.resolve(result ?? { status: 'completed', telemetry: { duration: 100 } });
    }
  }
}

/**
 * WorkflowScheduler runner cancellation tests.
 *
 * Exercises cooperative AbortSignal-based cancellation and the hard kill timer
 * that fires forceKill after cancelTimeoutMs.
 */
describe('WorkflowScheduler runner cancellation', () => {
  let runner: BlockingStepRunner;
  let activeExecutions: Map<string, ActiveExecution>;
  let shellAbortControllers: Map<string, AbortController>;
  let activeRunnerSteps: Map<string, ActiveRunnerStep>;
  let gateCoordinator: WorkflowGateCoordinator;
  let config: ExecutorConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    MakaioBus.__resetHandlers?.();
    runner = new BlockingStepRunner();
    activeExecutions = new Map();
    shellAbortControllers = new Map();
    activeRunnerSteps = new Map();
    gateCoordinator = new WorkflowGateCoordinator(MakaioBus);
    config = {
      ...DEFAULT_EXECUTOR_CONFIG,
      stepCooldownMs: 0,
      cancelTimeoutMs: 5_000,
      busAuth: { kind: 'none' },
      platformDefaults: { cwd: '/tmp' },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    MakaioBus.__resetHandlers?.();
  });

  /**
   * Helper: build scheduler deps from test state.
   */
  function buildDeps(): WorkflowSchedulerDeps {
    return {
      bus: MakaioBus,
      activeExecutions,
      shellAbortControllers,
      activeRunnerSteps,
      gateCoordinator,
      stepRunner: runner,
      config,
    };
  }

  /**
   * Helper: register minimal bus handlers for the scheduler to persist state.
   * Returns cleanup functions.
   */
  function registerMinimalBusHandlers(): Array<() => void> {
    const cleanups: Array<() => void> = [];
    cleanups.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        ctx.setResult({ success: true });
      }),
    );
    cleanups.push(MakaioBus.on(WorkflowSubjects.step.started, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.step.completed, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.step.failed, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.step.skipped, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.execution.completed, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.execution.failed, () => {}));
    cleanups.push(MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {}));
    return cleanups;
  }

  it('passes AbortSignal to the runner and aborts it on cancellation', async () => {
    const cleanups = registerMinimalBusHandlers();
    try {
      const workflow: WorkflowDefinition = {
        ...createWorkflowDefinition({
          id: 'wf-abort-signal',
          steps: [{ id: 'blocking', type: 'agent' as const, prompt: 'Block' }],
        }),
        createdAt: 0,
        updatedAt: 0,
      };
      const execution = createWorkflowExecution({
        id: 'exec-abort-signal',
        workflowId: workflow.id,
        steps: { blocking: { kind: 'executable', status: 'pending' } },
      });
      const active: ActiveExecution = {
        execution,
        workflow,
        stepMap: new Map(workflow.steps.map((s) => [s.id, s])),
        stepContext: new Map(),
      };
      activeExecutions.set(execution.id, active);

      const deps = buildDeps();
      const scheduler = new WorkflowScheduler(deps, execution.id);

      // Start the scheduler (it will block on the runner)
      const schedulerPromise = scheduler.run(workflow.steps);

      // Let the scheduler dispatch the step
      await vi.advanceTimersByTimeAsync(0);

      // The runner should have a pending step now, and an abort controller in the map
      const key = `${execution.id}:blocking`;
      expect(shellAbortControllers.has(key)).toBe(true);
      expect(activeRunnerSteps.has(key)).toBe(true);

      // Abort the controller (simulating cancellation)
      const abortController = shellAbortControllers.get(key)!;
      abortController.abort();

      // Verify the runner received the abort signal
      expect(runner.abortedSteps).toContain('blocking');

      // Now advance timers past cancelTimeoutMs to trigger forceKill
      await vi.advanceTimersByTimeAsync(config.cancelTimeoutMs);

      // forceKill should have been called
      expect(runner.forceKilledSteps).toContain('blocking');

      // Let the scheduler finish processing
      await schedulerPromise;
    } finally {
      cleanups.forEach((c) => c());
    }
  });

  it('clears the hard kill timer when the step completes before timeout', async () => {
    const cleanups = registerMinimalBusHandlers();
    try {
      const workflow: WorkflowDefinition = {
        ...createWorkflowDefinition({
          id: 'wf-timer-clear',
          steps: [{ id: 'fast', type: 'agent' as const, prompt: 'Fast' }],
        }),
        createdAt: 0,
        updatedAt: 0,
      };
      const execution = createWorkflowExecution({
        id: 'exec-timer-clear',
        workflowId: workflow.id,
        steps: { fast: { kind: 'executable', status: 'pending' } },
      });
      const active: ActiveExecution = {
        execution,
        workflow,
        stepMap: new Map(workflow.steps.map((s) => [s.id, s])),
        stepContext: new Map(),
      };
      activeExecutions.set(execution.id, active);

      const deps = buildDeps();
      const scheduler = new WorkflowScheduler(deps, execution.id);

      const schedulerPromise = scheduler.run(workflow.steps);

      // Let the scheduler dispatch the step
      await vi.advanceTimersByTimeAsync(0);

      const key = `${execution.id}:fast`;
      expect(activeRunnerSteps.has(key)).toBe(true);

      // Abort and then complete the step before the hard kill timer fires
      shellAbortControllers.get(key)!.abort();
      runner.complete('fast');

      // Advance timer just past the cancellation timeout
      await vi.advanceTimersByTimeAsync(config.cancelTimeoutMs + 1000);

      // forceKill should NOT have been called because the step completed
      expect(runner.forceKilledSteps).toEqual([]);

      // The active runner step entry should be cleaned up
      expect(activeRunnerSteps.has(key)).toBe(false);

      await schedulerPromise;
    } finally {
      cleanups.forEach((c) => c());
    }
  });

  it('registers and deregisters activeRunnerSteps around step dispatch', async () => {
    const cleanups = registerMinimalBusHandlers();
    try {
      const workflow: WorkflowDefinition = {
        ...createWorkflowDefinition({
          id: 'wf-register',
          steps: [{ id: 'tracked', type: 'agent' as const, prompt: 'Track' }],
        }),
        createdAt: 0,
        updatedAt: 0,
      };
      const execution = createWorkflowExecution({
        id: 'exec-register',
        workflowId: workflow.id,
        steps: { tracked: { kind: 'executable', status: 'pending' } },
      });
      const active: ActiveExecution = {
        execution,
        workflow,
        stepMap: new Map(workflow.steps.map((s) => [s.id, s])),
        stepContext: new Map(),
      };
      activeExecutions.set(execution.id, active);

      const deps = buildDeps();
      const scheduler = new WorkflowScheduler(deps, execution.id);

      const schedulerPromise = scheduler.run(workflow.steps);

      // Let the scheduler dispatch the step
      await vi.advanceTimersByTimeAsync(0);

      const key = `${execution.id}:tracked`;
      // During execution: entry exists
      expect(activeRunnerSteps.has(key)).toBe(true);
      const entry = activeRunnerSteps.get(key)!;
      expect(entry.controller).toBeInstanceOf(AbortController);

      // Complete the step
      runner.complete('tracked');
      await vi.advanceTimersByTimeAsync(0);
      await schedulerPromise;

      // After completion: entry removed
      expect(activeRunnerSteps.has(key)).toBe(false);
    } finally {
      cleanups.forEach((c) => c());
    }
  });
});
