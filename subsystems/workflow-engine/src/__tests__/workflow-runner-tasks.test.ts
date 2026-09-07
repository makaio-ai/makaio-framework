import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  type IWorkflowRunner,
  type WorkflowRunnerCompletion,
  type WorkflowWorkerConfig,
  WorkflowRunContextSchema,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { toCommittedWorkflowRunnerResult } from '../workflow-attempt-outcome.js';
import { type ActiveExecution } from '../types.js';
import {
  buildDefinitionRunnerParamsFromRunContext,
  buildExecutionTask,
  type RunnerTaskDeps,
} from '../workflow-runner-tasks.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';

describe('buildDefinitionRunnerParamsFromRunContext', () => {
  it('preserves durable dispatch metadata when marking a resume dispatch', () => {
    const workflow = createWorkflowDefinition({ id: 'wf-resume-metadata' });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'exec-resume-metadata',
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-resume-metadata',
      dispatchMetadata: { poolId: 'pool-original', provider: 'github-actions' },
      cancelSubject: 'workflow.exec-resume-metadata.cancel',
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'exit-and-resume',
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, workflow, { resume: true });

    expect(params.dispatchMetadata).toEqual({
      poolId: 'pool-original',
      provider: 'github-actions',
      resume: true,
    });
    expect(params.terminalAuthority).toBe('worker');
  });

  it.each([
    'worker',
    'authority',
  ] as const)('preserves explicit %s terminal ownership from durable run context', (terminalAuthority) => {
    const workflow = createWorkflowDefinition({ id: 'wf-terminal-authority' });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'exec-terminal-authority',
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-terminal-authority',
      cancelSubject: 'workflow.exec-terminal-authority.cancel',
      env: {},
      createdAt: Date.now(),
      terminalAuthority,
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, workflow, { resume: true });

    expect(params.terminalAuthority).toBe(terminalAuthority);
  });

  it('preserves the durable materialization spec for a path-backed resume', () => {
    const workflow = createWorkflowDefinition({ id: 'wf-path-resume' });
    const materializationSpec = {
      kind: 'workspace-snapshot' as const,
      snapshotId: 'snapshot-path-resume',
      digest: 'sha256-path-resume',
      sourcePath: 'workflows/path-resume.ts',
    };
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'exec-path-resume',
      workflowId: workflow.id,
      source: { kind: 'path', path: 'workflows/path-resume.ts' },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-path-resume',
      cancelSubject: 'workflow.exec-path-resume.cancel',
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'exit-and-redispatch',
      materializationSpec,
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, workflow, { resume: true });

    expect(params.materializationSpec).toEqual(materializationSpec);
  });
});

describe('worker-owned paused runner results', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it('releases host ownership without republishing a worker-paused execution', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-worker-paused' });
    const execution = createWorkflowExecution({ id: 'exec-worker-paused', workflowId: workflow.id });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-worker-paused',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'worker',
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
          runtimeLoopGates: new Map(),
        },
      ],
    ]);
    const shellAbortControllers = new Map();
    const activeRunnerSteps = new Map();
    const durableLifecycleTransitions = new Map<string, Promise<void>>();
    const lifecyclePublications = new Map<string, Promise<void>>();
    const publishingLifecycleExecutions = new Set<string>();
    const workerRunner: IWorkflowRunner = {
      run: async (config: WorkflowWorkerConfig): Promise<WorkflowRunnerCompletion> => {
        expect(config.terminalAuthority).toBe('worker');
        const { execution: running } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
          executionId: config.executionId,
        });
        if (!running) throw new Error('Worker-owned execution was not persisted.');
        await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
          execution: { ...running, status: 'paused' },
        });
        await MakaioBus.emit(WorkflowSubjects.execution.paused, {
          executionId: config.executionId,
          workflowId: config.workflowId,
          pausedAtGateId: 'gate-worker-paused',
          pausedAtFrameId: 'frame-worker-paused',
        });
        return {
          state: 'uncommitted',
          result: {
            executionId: config.executionId,
            workflowId: config.workflowId,
            status: 'paused',
            pausedAtGateId: 'gate-worker-paused',
            pausedAtFrameId: 'frame-worker-paused',
          },
        };
      },
    };
    const deps: RunnerTaskDeps = {
      workflowRunner: workerRunner,
      workflowAbortControllers: new Map(),
      executionTasks: new Map(),
      activeExecutions,
      buildFinalizerDeps: () => ({
        bus: MakaioBus,
        activeExecutions,
        shellAbortControllers,
        activeRunnerSteps,
        durableLifecycleTransitions,
        lifecyclePublications,
        publishingLifecycleExecutions,
      }),
      config: {
        stepTimeoutMs: 10_000,
        stepCooldownMs: 0,
        busAuth: { kind: 'none' },
        platformDefaults: { cwd: '/repo' },
        cancelTimeoutMs: 10_000,
      },
    };
    const pausedEvents: string[] = [];
    const offPaused = MakaioBus.on(WorkflowSubjects.execution.paused, (ctx) => {
      pausedEvents.push(ctx.payload.executionId);
    });

    try {
      await buildExecutionTask(deps, {
        executionId: execution.id,
        workflowId: workflow.id,
        workflow,
        source: { kind: 'definition', workflowId: workflow.id },
        coordinatorSessionId: runContext.coordinatorSessionId,
        sanitizedTriggerPayload: {},
        boundInputs: {},
        boundConfig: {},
        scope: { type: 'global' },
        terminalAuthority: 'worker',
      });

      expect(pausedEvents).toEqual([execution.id]);
      expect(activeExecutions.has(execution.id)).toBe(false);
      await expect(
        MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id }),
      ).resolves.toEqual(expect.objectContaining({ execution: expect.objectContaining({ status: 'paused' }) }));
    } finally {
      offPaused();
    }
  });
});

describe('authority-committed runner results', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    setup = undefined;
  });

  it.each([
    { scenario: 'refuses uncommitted completion', cancel: false, abort: false, finalizerCalls: 2 },
    {
      scenario: 'accepts a failed stop diagnostic after public cancellation',
      cancel: true,
      abort: true,
      finalizerCalls: 1,
    },
    {
      scenario: 'refuses cancelled/failed compatibility without runner abort',
      cancel: true,
      abort: false,
      finalizerCalls: 2,
    },
  ])('$scenario', async ({ cancel, abort, finalizerCalls }) => {
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
          runtimeLoopGates: new Map(),
        },
      ],
    ]);
    const workflowAbortControllers = new Map<string, AbortController>();
    const workerRunner: IWorkflowRunner = {
      run: async (config): Promise<WorkflowRunnerCompletion> => {
        if (cancel) {
          // Public cancellation owns durable state; the task's existing signal
          // separately records whether this runner was asked to stop.
          expect(
            await MakaioBus.request(WorkflowSubjects.cancel, {
              executionId: execution.id,
              reason: 'Operator stopped work',
            }),
          ).toMatchObject({ cancelled: true });
          if (abort) workflowAbortControllers.get(execution.id)?.abort('Operator stopped work');
          const result = toCommittedWorkflowRunnerResult(
            { kind: 'technical-failure', stage: 'workload-invocation', message: 'Process group did not stop' },
            config,
          );
          expect(result).toMatchObject({ status: 'failed', error: 'workload-invocation: Process group did not stop' });
          return { state: 'authority-committed', result };
        }
        return {
          state: 'authority-committed',
          result: { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' },
        };
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

    await buildExecutionTask(deps, {
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
    ).resolves.toEqual(
      expect.objectContaining({ execution: expect.objectContaining({ status: cancel ? 'cancelled' : 'failed' }) }),
    );
    // One access verifies committed state. A second access means verification
    // rejected the result and invoked the fallback finalizer instead.
    expect(observedFinalizerCalls).toBe(finalizerCalls);
    expect(activeExecutions.has(execution.id)).toBe(false);
    expect(workflowAbortControllers.has(execution.id)).toBe(false);
  });
});
