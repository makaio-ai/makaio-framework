import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  WorkflowErrorCode,
  type IWorkflowRunner,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition, createWorkflowExecution } from './shared.js';
import { expectExecutionStatus, expectRequestErrorCause, waitForRunnerAbort } from './workflow-public-test-utils.js';

describe('workflow public rerun subjects', () => {
  let setup: WorkflowExecutorTestSetup | undefined;

  beforeEach(async () => {
    setup = await setupWorkflowExecutorTest();
  });

  afterEach(async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }
  });

  it('reruns an execution from its stored definition snapshot', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const originalWorkflow = createWorkflowDefinition({
      id: 'public-rerun-snapshot',
      name: 'Public Rerun Snapshot v1',
      root: {
        id: 'public-rerun-snapshot-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow: originalWorkflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: originalWorkflow.id,
      input: { value: 'original' },
      config: { strict: true },
    });

    await MakaioBus.request(WorkflowSubjects.setDefinition, {
      workflow: {
        ...originalWorkflow,
        name: 'Public Rerun Snapshot v2',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
      reason: 'verify original topology',
    });

    expect(rerunExecutionId).not.toBe(originalExecutionId);

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.workflowId).toBe(originalWorkflow.id);
    expect(rerunRunContext?.definitionSnapshot?.name).toBe('Public Rerun Snapshot v1');
    expect(rerunRunContext?.inputs).toEqual({ value: 'original' });
    expect(rerunRunContext?.config).toEqual({ strict: true });

    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, {
      sourceExecutionId: originalExecutionId,
    });
    expect(links).toEqual([
      {
        sourceExecutionId: originalExecutionId,
        targetExecutionId: rerunExecutionId,
        linkType: 'rerun-of',
        metadata: {
          mode: 'snapshot',
          reason: 'verify original topology',
        },
      },
    ]);
  });

  it('inherits and overrides rerun run context fields from the original persisted context', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-context-fields',
      name: 'Public Rerun Context Fields',
      root: {
        id: 'public-rerun-context-fields-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const originalScope = {
      type: 'external',
      kind: 'project',
      id: 'rerun-context-original',
    } satisfies WorkflowExecutionScope;
    const originalArtifactRef = { kind: 'workpiece', id: 'rerun-context-original' };
    const originalExecutionHints = {
      providers: { piscina: { maxWorkers: 1 } },
    };
    const originalTriggerPayload = { source: 'original-trigger', count: 1 };

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: originalScope,
      artifactRef: originalArtifactRef,
      executionHints: originalExecutionHints,
      triggerPayload: originalTriggerPayload,
    });

    const { executionId: inheritedRerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });
    const { runContext: inheritedRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: inheritedRerunExecutionId,
    });
    expect(inheritedRunContext?.scope).toEqual(originalScope);
    expect(inheritedRunContext?.artifactRef).toEqual(originalArtifactRef);
    expect(inheritedRunContext?.executionHints).toEqual(originalExecutionHints);
    expect(inheritedRunContext?.triggerPayload).toEqual(originalTriggerPayload);

    const overrideScope = { type: 'session', id: 'rerun-context-override' } satisfies WorkflowExecutionScope;
    const overrideArtifactRef = { kind: 'implementation-plan', id: 'rerun-context-override' };
    const overrideExecutionHints = {
      providers: { 'github-actions': { pool: 'large' } },
    };
    const overrideTriggerPayload = { source: 'override-trigger', count: 2 };

    const { executionId: overrideRerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
      scope: overrideScope,
      artifactRef: overrideArtifactRef,
      executionHints: overrideExecutionHints,
      triggerPayload: overrideTriggerPayload,
    });
    const { runContext: overrideRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: overrideRerunExecutionId,
    });
    expect(overrideRunContext?.scope).toEqual(overrideScope);
    expect(overrideRunContext?.artifactRef).toEqual(overrideArtifactRef);
    expect(overrideRunContext?.executionHints).toEqual(overrideExecutionHints);
    expect(overrideRunContext?.triggerPayload).toEqual(overrideTriggerPayload);
  });

  it('reruns from persisted run context without requiring a completed source execution', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-any-persisted-context',
      name: 'Public Rerun Any Persisted Context',
      root: {
        id: 'public-rerun-any-persisted-context-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { source: 'non-completed-status' },
    });
    await expectExecutionStatus(originalExecutionId, 'completed');
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: originalExecutionId,
    });
    if (execution === null) {
      throw new Error('Expected original execution to be persisted before rerun.');
    }
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: {
        ...execution,
        status: 'failed',
        error: 'forced non-completed status for rerun contract',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });

    expect(runContext?.inputs).toEqual({ source: 'non-completed-status' });
  });

  it('uses the loaded snapshot definition id when rerunning file-backed executions', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const loadedWorkflow = createWorkflowDefinition({
      id: 'public-rerun-file-snapshot-logical-id',
      name: 'Public Rerun File Snapshot Logical Id',
      root: {
        id: 'public-rerun-file-snapshot-logical-id-root',
        type: 'sequence',
        nodes: [],
      },
    });
    const capturedConfigs: WorkflowWorkerConfig[] = [];
    let runCount = 0;
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount > 1) {
          return waitForRunnerAbort(config, signal);
        }
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const filePath = '/workspace/workflows/public-rerun-file-snapshot.ts';
    const originalCompletedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.runFile, { filePath });
    await expect(originalCompletedPromise).resolves.toBe(originalExecutionId);

    const { runContext: originalRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: originalExecutionId,
    });
    expect(originalRunContext?.workflowId).toBe(originalExecutionId);
    expect(originalRunContext?.source).toEqual({ kind: 'path', path: filePath });
    expect(originalRunContext?.definitionSnapshot?.id).toBe(loadedWorkflow.id);

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });

    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: filePath });
    expect(rerunConfig?.definition?.id).toBe(loadedWorkflow.id);

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunRunContext?.source).toEqual({ kind: 'path', path: filePath });
    expect(rerunRunContext?.definitionSnapshot?.id).toBe(loadedWorkflow.id);
  });

  it('reruns file-backed executions in current mode from the persisted source', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const loadedWorkflow = createWorkflowDefinition({
      id: 'public-rerun-file-current-source',
      name: 'Public Rerun File Current Source',
      root: {
        id: 'public-rerun-file-current-source-root',
        type: 'sequence',
        nodes: [],
      },
    });
    const capturedConfigs: WorkflowWorkerConfig[] = [];
    let runCount = 0;
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount > 1) {
          return waitForRunnerAbort(config, signal);
        }
        return runWorkflowOrchestrator({
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const filePath = '/workspace/workflows/public-rerun-file-current.ts';
    const originalCompletedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.runFile, { filePath });
    await expect(originalCompletedPromise).resolves.toBe(originalExecutionId);

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
    });

    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: filePath });
    expect(rerunConfig?.definition).toBeUndefined();
  });

  it('reruns failed file-backed executions in current mode without a loaded snapshot', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const capturedConfigs: WorkflowWorkerConfig[] = [];
    let runCount = 0;
    const workflowRunner: IWorkflowRunner = {
      run(config, signal) {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount === 1) {
          return Promise.reject(new Error('module load failed before snapshot persistence'));
        }
        return waitForRunnerAbort(config, signal);
      },
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner });

    const filePath = '/workspace/workflows/public-rerun-file-current-load-failure.ts';
    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.runFile, { filePath });
    await expectExecutionStatus(originalExecutionId, 'failed');

    const { runContext: originalRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: originalExecutionId,
    });
    expect(originalRunContext?.source).toEqual({ kind: 'path', path: filePath });
    expect(originalRunContext?.workflowId).toBe(originalExecutionId);
    expect(originalRunContext?.definitionSnapshot).toBeUndefined();

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
      input: { retry: true },
      config: { fixed: true },
      executionHints: { providers: { piscina: { maxWorkers: 1 } } },
      reason: 'source fixed',
    });

    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(rerunExecutionId);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: filePath });
    expect(rerunConfig?.definition).toBeUndefined();
    expect(rerunConfig?.inputs).toEqual({ retry: true });
    expect(rerunConfig?.config).toEqual({ fixed: true });
    expect(rerunConfig?.executionHints).toEqual({ providers: { piscina: { maxWorkers: 1 } } });

    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, {
      targetExecutionId: rerunExecutionId,
    });
    expect(links).toEqual([
      {
        sourceExecutionId: originalExecutionId,
        targetExecutionId: rerunExecutionId,
        linkType: 'rerun-of',
        metadata: { mode: 'current', reason: 'source fixed' },
      },
    ]);
  });

  it('reruns an execution from the current workflow definition', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = {
      ...createWorkflowDefinition({
        id: 'public-rerun-current',
        name: 'Public Rerun Current v1',
        root: {
          id: 'public-rerun-current-root',
          type: 'sequence',
          nodes: [],
        },
      }),
      executionHints: {
        providers: { piscina: { maxWorkers: 1 } },
      },
    };
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { value: 'original' },
    });

    await MakaioBus.request(WorkflowSubjects.setDefinition, {
      workflow: {
        ...workflow,
        name: 'Public Rerun Current v2',
        executionHints: {
          providers: { piscina: { maxWorkers: 4 } },
        },
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
      input: { value: 'override' },
    });

    const { runContext: rerunRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: rerunExecutionId,
    });
    expect(rerunRunContext?.definitionSnapshot?.name).toBe('Public Rerun Current v2');
    expect(rerunRunContext?.inputs).toEqual({ value: 'override' });
    expect(rerunRunContext?.executionHints).toEqual({ providers: { piscina: { maxWorkers: 4 } } });
  });

  it('rejects source-backed snapshot reruns when no runner-backed dispatch is available', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-source-requires-runner',
      name: 'Public Rerun Source Requires Runner',
      root: {
        id: 'public-rerun-source-requires-runner-root',
        type: 'sequence',
        nodes: [],
      },
    });
    const originalExecutionId = 'wfx-public-rerun-source-requires-runner';
    const runContext: WorkflowRunContext = {
      executionId: originalExecutionId,
      workflowId: workflow.id,
      source: { kind: 'path', path: '/repo/workflows/requires-runner.ts' },
      definitionSnapshot: workflow,
      workerManifest: { packages: [] },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-public-rerun-source-requires-runner',
      cancelSubject: `workflow.${originalExecutionId}.cancel`,
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'linux',
        arch: 'arm64',
      },
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'wait-in-process',
    };
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({
        id: originalExecutionId,
        workflowId: workflow.id,
        coordinatorSessionId: runContext.coordinatorSessionId,
        status: 'failed',
        error: 'original source run failed',
      }),
      runContext,
    });

    const error = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.NOT_EXECUTABLE,
      `Workflow source execution '${workflow.id}' requires a workflow runner or WorkerNode capability requirements.`,
    );
    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, {
      sourceExecutionId: originalExecutionId,
    });
    expect(links).toEqual([]);
  });

  it('fails snapshot rerun when the original execution has no definition snapshot', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const executionId = 'wfx-public-rerun-missing-snapshot';
    const runContext: WorkflowRunContext = {
      executionId,
      workflowId: 'public-rerun-missing-snapshot',
      source: { kind: 'path', path: '/repo/not-loaded-by-in-process-runner.mjs' },
      workerManifest: { packages: [] },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-public-rerun-missing-snapshot',
      cancelSubject: `workflow.${executionId}.cancel`,
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'linux',
        arch: 'arm64',
      },
      env: {},
      createdAt: Date.now(),
      suspensionStrategy: 'wait-in-process',
    };
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({
        id: executionId,
        workflowId: runContext.workflowId,
        coordinatorSessionId: runContext.coordinatorSessionId,
        status: 'failed',
        error: 'original source run failed before snapshot persistence',
      }),
      runContext,
    });

    const { runContext: persistedRunContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId,
    });
    expect(persistedRunContext?.source).toEqual({
      kind: 'path',
      path: '/repo/not-loaded-by-in-process-runner.mjs',
    });
    expect(persistedRunContext?.definitionSnapshot).toBeUndefined();

    const error = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId,
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.SNAPSHOT_UNAVAILABLE,
      `Workflow execution '${executionId}' does not have a definition snapshot.`,
    );
  });

  it('fails rerun with a typed code when the original run context is missing', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const error = await MakaioBus.request(WorkflowSubjects.rerun, {
      executionId: 'wfx-missing-run-context',
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.RUN_CONTEXT_NOT_FOUND,
      "Run context not found for workflow execution 'wfx-missing-run-context'.",
    );
  });
});
