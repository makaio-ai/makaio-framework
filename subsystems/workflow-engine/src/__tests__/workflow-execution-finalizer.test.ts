import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import {
  cancelExecution,
  completeExecutionWithFailure,
  completeExecutionWithSuccess,
  type FinalizerDeps,
} from '../workflow-execution-finalizer.js';
import type { ActiveExecution } from '../types.js';
import { WORKFLOW_CANCELLED_REASON } from '@makaio/contracts';
import type { WorkflowDefinition, WorkflowStepType } from '@makaio/contracts';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

describe('cancelExecution', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
    vi.restoreAllMocks();
  });

  it('removes the active execution when cancellation event emission fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    MakaioBus.__resetHandlers?.();
    const cleanupFns: Array<() => void> = [];

    cleanupFns.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        ctx.setResult({ success: ctx.payload.executionId === execution.id });
      }),
    );
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        throw new Error('cancelled event unavailable');
      }),
    );

    const workflow: WorkflowDefinition = {
      ...createWorkflowDefinition({
        steps: [{ id: 'plan', type: 'agent', prompt: 'Plan' }],
      }),
      createdAt: 0,
      updatedAt: 0,
    };
    const execution = createWorkflowExecution({
      id: 'execution-cancel-cleanup',
      workflowId: workflow.id,
      steps: { plan: { kind: 'executable', status: 'running' } },
    });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow,
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);

    const deps: FinalizerDeps = {
      bus: MakaioBus,
      activeExecutions,
      shellAbortControllers: new Map(),
      activeRunnerSteps: new Map(),
      gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
    };

    try {
      await expect(cancelExecution(deps, execution.id, 'test cancellation')).rejects.toThrow(
        'cancelled event unavailable',
      );

      expect(activeExecutions.has(execution.id)).toBe(false);
    } finally {
      cleanupFns.forEach((cleanup) => cleanup());
    }
  });

  it('terminalizes all non-terminal step states: pending, running, waiting, and expanding', async () => {
    MakaioBus.__resetHandlers?.();
    const cleanupFns: Array<() => void> = [];

    const persistHandler = vi.fn();
    const failedStepEvents: Array<{
      executionId: string;
      stepId: string;
      stepType: WorkflowStepType;
      error: string;
    }> = [];

    cleanupFns.push(
      MakaioBus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
        persistHandler(ctx.payload);
        ctx.setResult({ success: ctx.payload.executionId === execution.id });
      }),
    );
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.cancelled, () => {
        // no-op listener to prevent unhandled event warnings
      }),
    );
    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.step.failed, (ctx) => {
        failedStepEvents.push(ctx.payload);
      }),
    );

    const workflow: WorkflowDefinition = {
      ...createWorkflowDefinition({
        steps: [
          { id: 'pending-step', type: 'agent', prompt: 'Pending' },
          { id: 'running-step', type: 'agent', prompt: 'Running' },
          { id: 'waiting-step', type: 'gate', prompt: 'Waiting', autoAction: 'reject', timeoutMs: null },
          {
            id: 'foreach-expanding',
            type: 'for-each',
            collection: 'inputs.items',
            steps: [{ id: 'child', type: 'agent', prompt: 'Child' }],
          },
          { id: 'already-completed', type: 'agent', prompt: 'Already done' },
          { id: 'already-skipped', type: 'agent', prompt: 'Already skipped' },
          { id: 'already-failed', type: 'agent', prompt: 'Already failed' },
        ],
      }),
      createdAt: 0,
      updatedAt: 0,
    };

    const execution = createWorkflowExecution({
      id: 'execution-terminalize-all',
      workflowId: workflow.id,
      steps: {
        'pending-step': { kind: 'executable', status: 'pending' },
        'running-step': { kind: 'executable', status: 'running', subagentId: undefined },
        'waiting-step': { kind: 'executable', status: 'waiting' },
        'foreach-expanding': { kind: 'composite', status: 'expanding' },
        // Generated pending child from a previous partial expansion
        'foreach-expanding.0.child': { kind: 'executable', status: 'pending' },
        'already-completed': { kind: 'executable', status: 'completed' },
        'already-skipped': { kind: 'executable', status: 'skipped' },
        'already-failed': { kind: 'executable', status: 'failed', error: 'pre-existing failure' },
      },
    });

    const stepMap = new Map(workflow.steps.map((step) => [step.id, step]));

    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow,
          stepMap,
          stepContext: new Map(),
        },
      ],
    ]);

    const deps: FinalizerDeps = {
      bus: MakaioBus,
      activeExecutions,
      shellAbortControllers: new Map(),
      activeRunnerSteps: new Map(),
      gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
    };

    try {
      const cancelled = await cancelExecution(deps, execution.id, 'test cancellation');

      expect(cancelled).toBe(true);

      // Execution was removed from active registry
      expect(activeExecutions.has(execution.id)).toBe(false);

      // Storage was persisted exactly once (batch mutation via updateExecution)
      expect(persistHandler).toHaveBeenCalledTimes(1);

      // Verify the in-memory step states were correctly terminalized
      const steps = execution.steps;

      // Non-terminal states must be resolved
      expect(steps['pending-step']?.status).toBe('failed');
      expect(steps['running-step']?.status).toBe('failed');
      expect(steps['waiting-step']?.status).toBe('failed');
      expect(steps['foreach-expanding']?.status).toBe('cancelled');
      expect(steps['foreach-expanding.0.child']?.status).toBe('failed');

      // Already-terminal states must be untouched
      expect(steps['already-completed']?.status).toBe('completed');
      expect(steps['already-skipped']?.status).toBe('skipped');
      expect(steps['already-failed']?.status).toBe('failed');
      if (steps['already-failed']?.kind === 'executable') {
        expect(steps['already-failed'].error).toBe('pre-existing failure');
      }

      // No steps remain in a non-terminal state
      const nonTerminal = Object.values(steps).filter(
        (s) => s.status === 'pending' || s.status === 'running' || s.status === 'waiting' || s.status === 'expanding',
      );
      expect(nonTerminal).toHaveLength(0);

      expect(failedStepEvents).toEqual([
        {
          executionId: execution.id,
          stepId: 'pending-step',
          stepType: 'agent',
          error: WORKFLOW_CANCELLED_REASON,
        },
        {
          executionId: execution.id,
          stepId: 'running-step',
          stepType: 'agent',
          error: WORKFLOW_CANCELLED_REASON,
        },
        {
          executionId: execution.id,
          stepId: 'waiting-step',
          stepType: 'gate',
          error: WORKFLOW_CANCELLED_REASON,
        },
        {
          executionId: execution.id,
          stepId: 'foreach-expanding.0.child',
          stepType: 'agent',
          error: WORKFLOW_CANCELLED_REASON,
        },
      ]);
    } finally {
      cleanupFns.forEach((cleanup) => cleanup());
    }
  });
});

describe('execution completion finalizers', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
    vi.restoreAllMocks();
  });

  it('removes the active execution when successful completion persistence fails', async () => {
    MakaioBus.__resetHandlers?.();
    const workflow = createWorkflowDefinition();
    const execution = createWorkflowExecution({ workflowId: workflow.id });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow: { ...workflow, createdAt: 0, updatedAt: 0 },
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);
    MakaioBus.on(WorkflowStorageSubjects.updateExecution, () => {
      throw new Error('persist failed');
    });

    const deps: FinalizerDeps = {
      bus: MakaioBus,
      activeExecutions,
      shellAbortControllers: new Map(),
      activeRunnerSteps: new Map(),
      gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
    };

    await expect(completeExecutionWithSuccess(deps, execution, execution.id, Date.now())).rejects.toThrow(
      'persist failed',
    );
    expect(activeExecutions.has(execution.id)).toBe(false);
  });

  it('removes the active execution when failure persistence fails', async () => {
    MakaioBus.__resetHandlers?.();
    const workflow = createWorkflowDefinition();
    const execution = createWorkflowExecution({ workflowId: workflow.id });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow: { ...workflow, createdAt: 0, updatedAt: 0 },
          stepMap: new Map(workflow.steps.map((step) => [step.id, step])),
          stepContext: new Map(),
        },
      ],
    ]);
    MakaioBus.on(WorkflowStorageSubjects.updateExecution, () => {
      throw new Error('persist failed');
    });

    const deps: FinalizerDeps = {
      bus: MakaioBus,
      activeExecutions,
      shellAbortControllers: new Map(),
      activeRunnerSteps: new Map(),
      gateCoordinator: new WorkflowGateCoordinator(MakaioBus),
    };

    await expect(completeExecutionWithFailure(deps, execution, execution.id, 'boom')).rejects.toThrow('persist failed');
    expect(activeExecutions.has(execution.id)).toBe(false);
  });
});
