import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { type IWorkflowRunner, type WorkflowWorkerConfig, WorkflowRunContextSchema } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
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
      workerManifest: { packages: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-resume-metadata',
      executionHints: { requirements: { capabilities: ['workflow.remote'] } },
      dispatchMetadata: { poolId: 'pool-original', provider: 'github-actions' },
      cancelSubject: 'workflow.exec-resume-metadata.cancel',
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'darwin',
        arch: 'arm64',
      },
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
    expect(params.terminalAuthority).toBe('authority');
  });

  it('preserves explicit terminal ownership from durable run context', () => {
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
      context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'arm64' },
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'worker',
    });

    const params = buildDefinitionRunnerParamsFromRunContext(runContext, workflow, { resume: true });

    expect(params.terminalAuthority).toBe('worker');
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
      workerManifest: { packages: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-worker-paused',
      cancelSubject: `workflow.${execution.id}.cancel`,
      context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'arm64' },
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
      run: async (config: WorkflowWorkerConfig) => {
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
          executionId: config.executionId,
          workflowId: config.workflowId,
          status: 'paused',
          pausedAtGateId: 'gate-worker-paused',
          pausedAtFrameId: 'frame-worker-paused',
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
      resolveWorkflowContext: () => runContext.context,
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
        workspaceRoot: '/repo',
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
