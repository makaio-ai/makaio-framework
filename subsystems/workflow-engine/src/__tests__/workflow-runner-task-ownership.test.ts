import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunContextSchema, type WorkflowRunnerCompletion } from '@makaio/contracts';
import { buildExecutionTask, buildFileExecutionTask, type RunnerTaskDeps } from '../workflow-runner-tasks.js';
import { registerExecutionTask } from '../workflow-execution-task-registration.js';
import { toCommittedWorkflowRunnerCompletion } from '../workflow-attempt-outcome.js';
import type { ActiveExecution } from '../types.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

const identity = { executionId: 'execution-ownership', workflowId: 'workflow-ownership' };

function createTaskFixture(kind: 'file' | 'definition') {
  const workflow = createWorkflowDefinition({ id: identity.workflowId });
  const runContext = WorkflowRunContextSchema.parse({
    ...identity,
    source: { kind: 'definition', workflowId: identity.workflowId },
    definitionSnapshot: workflow,
    coordinatorSessionId: 'session-ownership',
    cancelSubject: `workflow.${identity.executionId}.cancel`,
    createdAt: Date.now(),
  });
  const first = Promise.withResolvers<WorkflowRunnerCompletion>();
  const second = Promise.withResolvers<WorkflowRunnerCompletion>();
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  let invoked = false;
  const deps: RunnerTaskDeps = {
    workflowRunner: {
      terminalAuthority: 'authority',
      run: () => {
        if (!invoked) {
          invoked = true;
          firstEntered.resolve();
          return first.promise;
        }
        secondEntered.resolve();
        return second.promise;
      },
    },
    activeExecutions: new Map(),
    workflowAbortControllers: new Map(),
    executionTasks: new Map(),
    buildFinalizerDeps: () => {
      throw new Error('An accepted Authority completion must not re-read or finalize mutable owner state');
    },
    config: {
      stepTimeoutMs: 10_000,
      stepCooldownMs: 0,
      busAuth: { kind: 'none' },
      platformDefaults: { cwd: '/repo' },
      cancelTimeoutMs: 10_000,
    },
  };
  const createActive = (): ActiveExecution => ({
    execution: createWorkflowExecution({ id: identity.executionId, workflowId: identity.workflowId }),
    workflow,
    runContext,
    runtimeHandlers: new Map(),
    runtimeLoopGates: new Map(),
  });
  const start = () => {
    const common = {
      ...identity,
      coordinatorSessionId: runContext.coordinatorSessionId,
      sanitizedTriggerPayload: {},
      boundInputs: {},
      boundConfig: {},
      scope: workflow.scope,
    };
    const task =
      kind === 'definition'
        ? buildExecutionTask(deps, { ...common, workflow, source: runContext.source, terminalAuthority: 'authority' })
        : buildFileExecutionTask(deps, {
            ...common,
            filePath: 'workflow.ts',
            triggerMode: 'immediate',
            materializationSpec: {
              kind: 'workspace-snapshot',
              snapshotId: 'snapshot-1',
              digest: 'digest-1',
              sourcePath: 'workflow.ts',
            },
          });
    // Resume adds caller-owned completion work, so the tracked task is not the
    // runner builder's inner promise. Registration owns this exact wrapper.
    const wrapped = task.finally(() => undefined);
    registerExecutionTask(deps.executionTasks, identity.executionId, wrapped);
    return wrapped;
  };
  return { deps, createActive, start, first, second, firstEntered, secondEntered };
}

describe.each(['file', 'definition'] as const)('%s runner task ownership', (kind) => {
  it.each([
    'projected-pause',
    'recorded-only',
    'rejected',
  ] as const)('keeps a resumed successor when its predecessor finishes with %s', async (mode) => {
    const fixture = createTaskFixture(kind);
    const { deps } = fixture;
    deps.activeExecutions.set(identity.executionId, fixture.createActive());
    const predecessor = fixture.start();
    await fixture.firstEntered.promise;
    const predecessorController = deps.workflowAbortControllers.get(identity.executionId);

    const successorActive = fixture.createActive();
    deps.activeExecutions.set(identity.executionId, successorActive);
    const successor = fixture.start();
    await fixture.secondEntered.promise;
    const successorController = deps.workflowAbortControllers.get(identity.executionId);
    const error = new Error('Late predecessor transport failure');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      if (mode === 'rejected') {
        predecessorController?.abort('Old attempt cancelled');
        fixture.first.reject(error);
      } else {
        fixture.first.resolve(
          toCommittedWorkflowRunnerCompletion(
            {
              outcome:
                mode === 'projected-pause'
                  ? { ...identity, status: 'paused', pausedAtGateId: 'gate-1', pausedAtFrameId: 'frame-1' }
                  : { ...identity, status: 'completed' },
              controlObservation: { controlRevision: 0, cancellation: null },
              acceptance: mode === 'projected-pause' ? 'projected' : 'recorded-only',
            },
            identity,
          ),
        );
      }
      await predecessor;
      expect(deps.activeExecutions.get(identity.executionId)).toBe(successorActive);
      expect(successorActive.execution.status).toBe('running');
      expect(deps.workflowAbortControllers.get(identity.executionId)).toBe(successorController);
      expect(successorController?.signal.aborted).toBe(false);
      expect(deps.executionTasks.get(identity.executionId)).toBe(successor);
      if (mode === 'rejected') expect(logged).toHaveBeenCalledWith(expect.stringContaining('Superseded'), error);
      else expect(logged).not.toHaveBeenCalled();
    } finally {
      fixture.second.resolve(
        toCommittedWorkflowRunnerCompletion(
          {
            outcome: { ...identity, status: 'completed' },
            acceptance: 'projected',
            controlObservation: null,
          },
          identity,
        ),
      );
      await successor;
      logged.mockRestore();
    }
    expect(deps.activeExecutions.size).toBe(0);
    expect(deps.workflowAbortControllers.size).toBe(0);
    expect(deps.executionTasks.size).toBe(0);
  });

  it('accepts explicit owner acceptance even when no local active entry exists', async () => {
    const fixture = createTaskFixture(kind);
    const task = fixture.start();
    await fixture.firstEntered.promise;
    fixture.first.resolve(
      toCommittedWorkflowRunnerCompletion(
        {
          outcome: { ...identity, status: 'completed' },
          acceptance: 'projected',
          controlObservation: null,
        },
        identity,
      ),
    );
    await task;
    expect(fixture.deps.workflowAbortControllers.size).toBe(0);
    expect(fixture.deps.executionTasks.size).toBe(0);
  });
});

it('retains a registered task rejection for its caller and reports it while cleaning the registry', async () => {
  const tasks = new Map<string, Promise<void>>();
  const deferred = Promise.withResolvers<void>();
  const error = new Error('Execution failed outside runner error handling');
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    registerExecutionTask(tasks, identity.executionId, deferred.promise);
    deferred.reject(error);
    await expect(deferred.promise).rejects.toBe(error);
    await Promise.resolve();
    expect(tasks.size).toBe(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Execution task failed'), error);
  } finally {
    logged.mockRestore();
  }
});
