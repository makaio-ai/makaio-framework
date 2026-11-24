import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import {
  WorkflowErrorCode,
  isDefinitionInvalidError,
  type IWorkflowRunner,
  type WorkflowExecutionScope,
  type WorkflowRunContext,
  type WorkflowRunnerCompletion,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runCallerLocalWorkflowOrchestrator } from '../workflow-orchestrator.js';
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
    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, { workflow: originalWorkflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, {
      workflowId: originalWorkflow.id,
      input: { value: 'original' },
      config: { strict: true },
    });

    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, {
      workflow: {
        ...originalWorkflow,
        name: 'Public Rerun Snapshot v2',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
      reason: 'verify original topology',
    });

    expect(rerunExecutionId).not.toBe(originalExecutionId);

    const { runContext: rerunRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: rerunExecutionId,
      },
    );
    expect(rerunRunContext?.workflowId).toBe(originalWorkflow.id);
    expect(rerunRunContext?.definitionSnapshot).toMatchObject({ name: 'Public Rerun Snapshot v1' });
    expect(rerunRunContext?.inputs).toEqual({ value: 'original' });
    expect(rerunRunContext?.config).toEqual({ strict: true });

    const { links } = await MakaioBus.request(createTestCall(), WorkflowSubjects.listExecutionLinks, {
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
    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, { workflow });

    const originalScope = {
      type: 'external',
      kind: 'project',
      id: 'rerun-context-original',
    } satisfies WorkflowExecutionScope;
    const originalArtifactRef = { kind: 'workpiece', id: 'rerun-context-original' };
    const originalTriggerPayload = { source: 'original-trigger', count: 1 };

    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: originalScope,
      artifactRef: originalArtifactRef,
      triggerPayload: originalTriggerPayload,
    });

    const { executionId: inheritedRerunExecutionId } = await MakaioBus.request(
      createTestCall(),
      WorkflowSubjects.rerun,
      {
        executionId: originalExecutionId,
        mode: 'snapshot',
      },
    );
    const { runContext: inheritedRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: inheritedRerunExecutionId,
      },
    );
    expect(inheritedRunContext?.scope).toEqual(originalScope);
    expect(inheritedRunContext?.artifactRef).toEqual(originalArtifactRef);
    expect(inheritedRunContext?.triggerPayload).toEqual(originalTriggerPayload);

    const overrideScope = { type: 'session', id: 'rerun-context-override' } satisfies WorkflowExecutionScope;
    const overrideArtifactRef = { kind: 'implementation-plan', id: 'rerun-context-override' };
    const overrideTriggerPayload = { source: 'override-trigger', count: 2 };

    const { executionId: overrideRerunExecutionId } = await MakaioBus.request(
      createTestCall(),
      WorkflowSubjects.rerun,
      {
        executionId: originalExecutionId,
        mode: 'snapshot',
        scope: overrideScope,
        artifactRef: overrideArtifactRef,
        triggerPayload: overrideTriggerPayload,
      },
    );
    const { runContext: overrideRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: overrideRerunExecutionId,
      },
    );
    expect(overrideRunContext?.scope).toEqual(overrideScope);
    expect(overrideRunContext?.artifactRef).toEqual(overrideArtifactRef);
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
    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { source: 'non-completed-status' },
    });
    await expectExecutionStatus(originalExecutionId, 'completed');
    const { execution } = await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getExecution, {
      executionId: originalExecutionId,
    });
    if (execution === null) {
      throw new Error('Expected original execution to be persisted before rerun.');
    }
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecution, {
      execution: {
        ...execution,
        status: 'failed',
        error: 'forced non-completed status for rerun contract',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });
    const { runContext } = await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getRunContext, {
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
    const callerLocalFileRunner: IWorkflowRunner = {
      async run(call, config, signal): Promise<WorkflowRunnerCompletion> {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount > 1) {
          return waitForRunnerAbort(config, signal);
        }
        const result = await runCallerLocalWorkflowOrchestrator({
          call,
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };
    const fallbackRunner: IWorkflowRunner = {
      run: vi.fn((_call, config, signal) => waitForRunnerAbort(config, signal)),
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner: fallbackRunner, callerLocalFileRunner });

    const filePath = '/workspace/workflows/public-rerun-file-snapshot.ts';
    const originalCompletedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.runFile, {
      filePath,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workspace-public-rerun',
        rootDigest: 'sha256-public-rerun-file-snapshot',
        sourcePath: 'workflows/public-rerun-file-snapshot.ts',
      },
    });
    await expect(originalCompletedPromise).resolves.toBe(originalExecutionId);

    const { runContext: originalRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: originalExecutionId,
      },
    );
    expect(originalRunContext?.workflowId).toBe(originalExecutionId);
    expect(originalRunContext?.source).toEqual({ kind: 'path', path: 'workflows/public-rerun-file-snapshot.ts' });
    expect(originalRunContext?.definitionSnapshot).toMatchObject({ id: loadedWorkflow.id });

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });

    expect(fallbackRunner.run).not.toHaveBeenCalled();
    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: 'workflows/public-rerun-file-snapshot.ts' });
    expect(rerunConfig?.definition?.id).toBe(loadedWorkflow.id);

    const { runContext: rerunRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: rerunExecutionId,
      },
    );
    expect(rerunRunContext?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunRunContext?.source).toEqual({ kind: 'path', path: 'workflows/public-rerun-file-snapshot.ts' });
    expect(rerunRunContext?.definitionSnapshot).toMatchObject({ id: loadedWorkflow.id });
  });

  it.each([
    true,
    false,
  ])('keeps a direct file rerun on the file runner (registered definition: %s)', async (hasDefinition) => {
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
    const callerLocalFileRunner: IWorkflowRunner = {
      async run(call, config, signal): Promise<WorkflowRunnerCompletion> {
        capturedConfigs.push(config);
        runCount += 1;
        if (runCount > 1) {
          return waitForRunnerAbort(config, signal);
        }
        const result = await runCallerLocalWorkflowOrchestrator({
          call,
          config,
          loaded: {
            definition: loadedWorkflow,
            runtimeHandlers: new Map(),
          },
          bus: MakaioBus,
          signal,
        });
        return { state: 'uncommitted', result };
      },
    };
    const fallbackRunner: IWorkflowRunner = {
      run: vi.fn((_call, config, signal) => waitForRunnerAbort(config, signal)),
    };
    setup = await setupWorkflowExecutorTest({ workflowRunner: fallbackRunner, callerLocalFileRunner });

    const filePath = '/workspace/workflows/public-rerun-file-current.ts';
    const originalCompletedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.runFile, {
      filePath,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workspace-public-rerun',
        rootDigest: 'sha256-public-rerun-file-current',
        sourcePath: 'workflows/public-rerun-file-current.ts',
      },
    });
    await expect(originalCompletedPromise).resolves.toBe(originalExecutionId);

    if (hasDefinition) {
      await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, {
        workflow: { ...loadedWorkflow, name: 'Registered workflow with the same ID' },
      });
    }

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
    });

    expect(fallbackRunner.run).not.toHaveBeenCalled();
    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(loadedWorkflow.id);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: 'workflows/public-rerun-file-current.ts' });
    expect(rerunConfig?.definition).toBeUndefined();
    await expect(
      MakaioBus.request(createTestCall(), WorkflowStorageSubjects.getRunContext, { executionId: rerunExecutionId }),
    ).resolves.toMatchObject({
      runContext: { definitionSnapshot: { id: loadedWorkflow.id } },
    });

    const secondReplay = MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: rerunExecutionId,
      mode: 'current',
    });
    if (hasDefinition) {
      const { executionId: secondReplayId } = await secondReplay;
      expect(fallbackRunner.run).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({
          executionId: secondReplayId,
          workflowId: loadedWorkflow.id,
          source: { kind: 'definition', workflowId: loadedWorkflow.id },
          definition: expect.objectContaining({ name: 'Registered workflow with the same ID' }),
        }),
        expect.any(AbortSignal),
        undefined,
        expect.anything(),
      );
    } else {
      await expect(secondReplay).rejects.toMatchObject({
        cause: { code: WorkflowErrorCode.DEFINITION_NOT_FOUND, message: `Workflow not found: ${loadedWorkflow.id}` },
      });
    }
    expect(capturedConfigs).toHaveLength(2);
  });

  it('reruns failed file-backed executions in current mode without a loaded snapshot', async () => {
    if (setup) {
      await teardownWorkflowExecutorTest(setup);
      setup = undefined;
    }

    const capturedConfigs: WorkflowWorkerConfig[] = [];
    let runCount = 0;
    const workflowRunner: IWorkflowRunner = {
      run(_call, config, signal): Promise<WorkflowRunnerCompletion> {
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
    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.runFile, {
      filePath,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workspace-public-rerun',
        rootDigest: 'sha256-public-rerun-file-current-load-failure',
        sourcePath: 'workflows/public-rerun-file-current-load-failure.ts',
      },
    });
    await expectExecutionStatus(originalExecutionId, 'failed');

    const { runContext: originalRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: originalExecutionId,
      },
    );
    expect(originalRunContext?.source).toEqual({
      kind: 'path',
      path: 'workflows/public-rerun-file-current-load-failure.ts',
    });
    expect(originalRunContext?.workflowId).toBe(originalExecutionId);
    expect(originalRunContext?.definitionSnapshot).toBeUndefined();

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
      input: { retry: true },
      config: { fixed: true },
      reason: 'source fixed',
    });

    const rerunConfig = capturedConfigs.at(1);
    expect(rerunConfig?.executionId).toBe(rerunExecutionId);
    expect(rerunConfig?.workflowId).toBe(rerunExecutionId);
    expect(rerunConfig?.source).toEqual({ kind: 'path', path: 'workflows/public-rerun-file-current-load-failure.ts' });
    expect(rerunConfig?.definition).toBeUndefined();
    expect(rerunConfig?.inputs).toEqual({ retry: true });
    expect(rerunConfig?.config).toEqual({ fixed: true });

    const { links } = await MakaioBus.request(createTestCall(), WorkflowSubjects.listExecutionLinks, {
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

    const workflow = createWorkflowDefinition({
      id: 'public-rerun-current',
      name: 'Public Rerun Current v1',
      root: {
        id: 'public-rerun-current-root',
        type: 'sequence',
        nodes: [],
      },
    });
    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, { workflow });

    const { executionId: originalExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { value: 'original' },
    });

    await MakaioBus.request(createTestCall(), WorkflowSubjects.setDefinition, {
      workflow: {
        ...workflow,
        name: 'Public Rerun Current v2',
      },
    });

    const { executionId: rerunExecutionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'current',
      input: { value: 'override' },
    });

    const { runContext: rerunRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId: rerunExecutionId,
      },
    );
    expect(rerunRunContext?.definitionSnapshot).toMatchObject({ name: 'Public Rerun Current v2' });
    expect(rerunRunContext?.inputs).toEqual({ value: 'override' });
  });

  it('reports a typed error when the definition for a current replay has been deleted', async () => {
    const call = createTestCall();
    const workflow = createWorkflowDefinition({
      id: 'public-rerun-deleted-definition',
      root: { id: 'deleted-definition-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(call, WorkflowSubjects.setDefinition, { workflow });
    const { executionId } = await MakaioBus.request(call, WorkflowSubjects.start, { workflowId: workflow.id });
    await expectExecutionStatus(executionId, 'completed');
    await expect(MakaioBus.request(call, WorkflowSubjects.deleteDefinition, { id: workflow.id })).resolves.toEqual({
      deleted: true,
    });

    await expect(
      MakaioBus.request(call, WorkflowSubjects.rerun, { executionId, mode: 'current' }),
    ).rejects.toMatchObject({
      cause: { code: WorkflowErrorCode.DEFINITION_NOT_FOUND, message: `Workflow not found: ${workflow.id}` },
    });
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
      source: { kind: 'path', path: 'workflows/requires-runner.ts' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'repo',
        rootDigest: 'digest',
        sourcePath: 'workflows/requires-runner.ts',
      },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-public-rerun-source-requires-runner',
      cancelSubject: `workflow.${originalExecutionId}.cancel`,
      env: {},
      createdAt: Date.now(),
    };
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({
        id: originalExecutionId,
        workflowId: workflow.id,
        coordinatorSessionId: runContext.coordinatorSessionId,
        status: 'failed',
        error: 'original source run failed',
      }),
      runContext,
    });

    const error = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.NOT_EXECUTABLE,
      `Workflow source execution '${workflow.id}' requires a workflow runner.`,
    );
    const { links } = await MakaioBus.request(createTestCall(), WorkflowSubjects.listExecutionLinks, {
      sourceExecutionId: originalExecutionId,
    });
    expect(links).toEqual([]);
  });

  it('keeps an Authority-owned path snapshot on its definition runner', async () => {
    if (setup) await teardownWorkflowExecutorTest(setup);
    const callerLocalFileRunner: IWorkflowRunner = { run: vi.fn() };
    const authorityRunner: IWorkflowRunner = {
      terminalAuthority: 'authority',
      run: vi.fn((_call, config, signal) => waitForRunnerAbort(config, signal)),
    };
    setup = await setupWorkflowExecutorTest({ callerLocalFileRunner });
    setup.cleanupFns.push(setup.workflowExecutor.registerWorkflowRunnerSelector(() => authorityRunner));
    const workflow = createWorkflowDefinition({ id: 'authority-path-replay' });
    const originalExecutionId = 'wfx-authority-path-replay';
    const source = { kind: 'path', path: 'workflows/authority-replay.mjs' } as const;
    const runContext: WorkflowRunContext = {
      executionId: originalExecutionId,
      workflowId: workflow.id,
      source,
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'repo',
        rootDigest: 'digest',
        sourcePath: source.path,
      },
      definitionSnapshot: workflow,
      workerManifest: { contributionRefs: [] },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-authority-path-replay',
      cancelSubject: `workflow.${originalExecutionId}.cancel`,
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'authority',
    };
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({
        id: originalExecutionId,
        workflowId: workflow.id,
        coordinatorSessionId: runContext.coordinatorSessionId,
      }),
      runContext,
    });

    const { executionId } = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: originalExecutionId,
      mode: 'snapshot',
    });

    expect(callerLocalFileRunner.run).not.toHaveBeenCalled();
    expect(authorityRunner.run).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ executionId, source, definition: workflow, terminalAuthority: 'authority' }),
      expect.any(AbortSignal),
      undefined,
      expect.anything(),
    );
  });

  it('fails snapshot rerun when the original execution has no definition snapshot', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const executionId = 'wfx-public-rerun-missing-snapshot';
    const runContext: WorkflowRunContext = {
      executionId,
      workflowId: 'public-rerun-missing-snapshot',
      source: { kind: 'path', path: 'not-loaded-by-in-process-runner.mjs' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'repo',
        rootDigest: 'digest',
        sourcePath: 'not-loaded-by-in-process-runner.mjs',
      },
      workerManifest: { contributionRefs: [] },
      inputs: {},
      config: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-public-rerun-missing-snapshot',
      cancelSubject: `workflow.${executionId}.cancel`,
      env: {},
      createdAt: Date.now(),
    };
    await MakaioBus.request(createTestCall(), WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({
        id: executionId,
        workflowId: runContext.workflowId,
        coordinatorSessionId: runContext.coordinatorSessionId,
        status: 'failed',
        error: 'original source run failed before snapshot persistence',
      }),
      runContext,
    });

    const { runContext: persistedRunContext } = await MakaioBus.request(
      createTestCall(),
      WorkflowStorageSubjects.getRunContext,
      {
        executionId,
      },
    );
    expect(persistedRunContext?.source).toEqual({
      kind: 'path',
      path: 'not-loaded-by-in-process-runner.mjs',
    });
    expect(persistedRunContext?.definitionSnapshot).toBeUndefined();

    const error = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
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

    const error = await MakaioBus.request(createTestCall(), WorkflowSubjects.rerun, {
      executionId: 'wfx-missing-run-context',
      mode: 'snapshot',
    }).catch((value: unknown) => value);

    expectRequestErrorCause(
      error,
      WorkflowErrorCode.RUN_CONTEXT_NOT_FOUND,
      "Run context not found for workflow execution 'wfx-missing-run-context'.",
    );
  });

  describe.each(['strict', 'production'] as const)('stored snapshot reruns in %s mode', (validationMode) => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', validationMode === 'production' ? 'production' : 'test');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    const legacyStation = { id: 'stored-step', type: 'station', role: 'reviewer', prompt: 'Review' }; // legacy-input
    it.each([
      {
        title: 'rejects snapshot reruns with a legacy station before writing',
        mode: 'snapshot',
        sourceKind: 'source',
        rejects: true,
        legacyNode: legacyStation,
      },
      {
        title: 'rejects snapshot reruns with a legacy Gate before writing',
        mode: 'snapshot',
        sourceKind: 'source',
        rejects: true,
        legacyNode: {
          id: 'stored-approval',
          type: 'gate', // legacy-input
          prompt: 'Approve the run',
          autoAction: 'reject',
          timeoutMs: null,
        },
      },
      {
        title: 'rejects current reruns of ephemeral source executions before writing',
        mode: 'current',
        sourceKind: 'source',
        rejects: true,
        legacyNode: legacyStation,
      },
      {
        title: 'starts definition-backed current reruns from the current definition despite an unreadable snapshot',
        mode: 'current',
        sourceKind: 'definition',
        rejects: false,
        legacyNode: legacyStation,
      },
    ] as const)('$title', async ({ mode, sourceKind, rejects, legacyNode }) => {
      if (!setup) {
        throw new Error('Workflow executor test setup did not initialize.');
      }
      const call = MakaioBus.own('start');
      const executionId = `wfx-stored-snapshot-${sourceKind}-${mode}`;
      const workflow = createWorkflowDefinition({
        id: `stored-snapshot-${sourceKind}-${mode}`,
        name: `Current definition ${sourceKind} ${mode}`,
        root: { id: 'current-root', type: 'sequence', nodes: [] },
      });
      await MakaioBus.request(call, WorkflowSubjects.setDefinition, { workflow });
      const workflowId = sourceKind === 'source' ? executionId : workflow.id;
      const runContext: WorkflowRunContext = {
        executionId,
        workflowId,
        source:
          sourceKind === 'source'
            ? { kind: 'source', filename: 'stored-snapshot.ts', source: 'export default {};' }
            : { kind: 'definition', workflowId },
        definitionSnapshot: workflow,
        workerManifest: { contributionRefs: [] },
        inputs: { original: true },
        scope: { type: 'global' },
        triggerPayload: {},
        coordinatorSessionId: `session-${executionId}`,
        cancelSubject: `workflow.${executionId}.cancel`,
        env: {},
        createdAt: Date.now(),
      };
      await MakaioBus.request(call, WorkflowStorageSubjects.setExecutionStart, {
        execution: createWorkflowExecution({
          id: executionId,
          workflowId,
          coordinatorSessionId: runContext.coordinatorSessionId,
          status: 'failed',
        }),
        runContext,
      });
      const legacySnapshot = {
        ...workflow,
        name: 'Stored legacy snapshot',
        root: {
          id: 'stored-root',
          type: 'sequence',
          nodes: [legacyNode],
        },
      };
      await setup.dbContext.exec(sql`
        UPDATE workflow_run_contexts
        SET definition_snapshot = ${JSON.stringify(legacySnapshot)}
        WHERE execution_id = ${executionId}
      `);
      const stored = await MakaioBus.request(call, WorkflowSubjects.getRunContext, { executionId });
      expect(stored.definitionSnapshot).toEqual(legacySnapshot);

      if (!rejects) {
        const { executionId: rerunExecutionId } = await MakaioBus.request(call, WorkflowSubjects.rerun, {
          executionId,
          mode,
        });
        const rerun = await MakaioBus.request(call, WorkflowSubjects.getRunContext, { executionId: rerunExecutionId });
        expect(rerun.definitionSnapshot).toEqual(workflow);
        const { links } = await MakaioBus.request(call, WorkflowSubjects.listExecutionLinks, {
          sourceExecutionId: executionId,
        });
        expect(links).toMatchObject([{ sourceExecutionId: executionId, targetExecutionId: rerunExecutionId }]);
        return;
      }
      const messages: string[] = [];
      const stopObserving = MakaioBus.observeMessages((message) => {
        messages.push(`${message.type}:${message.namespace}.${message.subject}`);
      });
      let error: unknown;
      try {
        error = await MakaioBus.request(call, WorkflowSubjects.rerun, { executionId, mode }).catch(
          (value: unknown) => value,
        );
      } finally {
        stopObserving();
      }
      expect(isDefinitionInvalidError(error)).toBe(true);
      if (!(error instanceof RequestError)) {
        throw new Error('Expected the public rerun request to wrap its workflow error.');
      }
      expect(error.cause).toMatchObject({
        code: WorkflowErrorCode.DEFINITION_INVALID,
        message: expect.stringContaining(executionId),
      });
      expect(error.cause).toHaveProperty('message', expect.stringContaining('definitionSnapshot.root.nodes.0.type'));
      // A rejected rerun must not reserve a coordinator, dispatch a worker, or issue a storage write.
      expect(messages).toEqual(['request:workflow.rerun', 'request:storage:workflow.getRunContext']);
      expect(await MakaioBus.request(call, WorkflowSubjects.getRunContext, { executionId })).toEqual(stored);
      const { executions } = await MakaioBus.request(call, WorkflowStorageSubjects.listExecutions, {
        workflowId,
        limit: 50,
      });
      expect(executions.map((execution) => execution.id)).toEqual([executionId]);
      const { links } = await MakaioBus.request(call, WorkflowSubjects.listExecutionLinks, {
        sourceExecutionId: executionId,
      });
      expect(links).toEqual([]);
    });
  });
});
