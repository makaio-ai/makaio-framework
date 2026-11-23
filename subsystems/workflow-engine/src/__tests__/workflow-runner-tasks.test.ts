import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { type IWorkflowRunner, type WorkflowRunnerCompletion, WorkflowRunContextSchema } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { toCommittedWorkflowRunnerCompletion } from '../workflow-attempt-outcome.js';
import { type ActiveExecution } from '../types.js';
import { buildExecutionTask, type RunnerTaskDeps } from '../workflow-runner-tasks.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

describe('recorded-only runner results', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it.each([
    {
      scenario: 'records a failed stop diagnostic after public cancellation',
      outcomeStatus: 'technical-failure',
      abort: true,
    },
    {
      scenario: 'records a cancelled owner diagnostic without a local abort signal',
      outcomeStatus: 'technical-failure',
      abort: false,
    },
    {
      scenario: 'records Completed after owner cancellation without success projection',
      outcomeStatus: 'completed',
      abort: false,
    },
  ] as const)('$scenario', async ({ abort, outcomeStatus }) => {
    const workflow = createWorkflowDefinition({ id: 'wf-faulty-authority-commit' });
    const execution = createWorkflowExecution({ id: 'exec-faulty-authority-commit', workflowId: workflow.id });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-faulty-authority-commit',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'authority',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });
    const activeExecutions = new Map<string, ActiveExecution>([
      [
        execution.id,
        {
          execution,
          workflow,
          runContext,
          runtimeHandlers: new Map(),
          runtimeLoopChecks: new Map(),
        },
      ],
    ]);
    const workflowAbortControllers = new Map<string, AbortController>();
    const workerRunner: IWorkflowRunner = {
      run: async (call, config): Promise<WorkflowRunnerCompletion> => {
        // Public cancellation owns durable state; the task's existing signal
        // separately records whether this runner was asked to stop.
        expect(
          await MakaioBus.request(call, WorkflowSubjects.cancel, {
            executionId: execution.id,
            reason: 'Operator stopped work',
          }),
        ).toMatchObject({ cancelled: true });
        if (abort) workflowAbortControllers.get(execution.id)?.abort('Operator stopped work');
        return toCommittedWorkflowRunnerCompletion(
          {
            outcome:
              outcomeStatus === 'technical-failure'
                ? {
                    kind: 'technical-failure',
                    stage: 'workload-invocation',
                    message: 'Process group did not stop',
                  }
                : {
                    executionId: config.executionId,
                    workflowId: config.workflowId,
                    status: 'completed',
                  },
            controlObservation: null,
            acceptance: 'recorded-only',
          },
          config,
        );
      },
    };
    let observedFinalizerCalls = 0;
    const deps: RunnerTaskDeps = {
      workflowRunner: workerRunner,
      workflowAbortControllers,
      executionTasks: new Map(),
      activeExecutions,
      buildFinalizerDeps: () => {
        observedFinalizerCalls += 1;
        return {
          bus: MakaioBus,
          activeExecutions,
          shellAbortControllers: new Map(),
          activeRunnerSteps: new Map(),
          durableLifecycleTransitions: new Map(),
          lifecyclePublications: new Map(),
          publishingLifecycleExecutions: new Set(),
        };
      },
      config: {
        stepTimeoutMs: 10_000,
        stepCooldownMs: 0,
        busAuth: { kind: 'none' },
        platformDefaults: { cwd: '/repo' },
        cancelTimeoutMs: 10_000,
      },
    };

    await buildExecutionTask(createTestCall(), deps, {
      executionId: execution.id,
      workflowId: workflow.id,
      workflow,
      source: { kind: 'definition', workflowId: workflow.id },
      coordinatorSessionId: runContext.coordinatorSessionId,
      sanitizedTriggerPayload: {},
      boundInputs: {},
      boundConfig: {},
      scope: { type: 'global' },
      terminalAuthority: 'authority',
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id }),
    ).resolves.toEqual(expect.objectContaining({ execution: expect.objectContaining({ status: 'cancelled' }) }));
    expect(observedFinalizerCalls).toBe(0);
    expect(activeExecutions.has(execution.id)).toBe(false);
    expect(workflowAbortControllers.has(execution.id)).toBe(false);
  });
});
