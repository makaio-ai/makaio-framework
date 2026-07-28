import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowRunContextSchema, type WorkflowRunContext } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';
import { buildWorkflowRunContext } from '../workflow-run-context-builder.js';
import { createTestDb, createWorkflowDefinition, createWorkflowExecution, type TestDbContext } from './shared.js';

/**
 * Persist a run context together with its parent execution row.
 *
 * `workflow_run_contexts.execution_id` references `workflow_executions.id`
 * (1:1, cascade delete), so the execution row must exist before the
 * run-context snapshot can be stored.
 * @param runContext - Run context to persist.
 */
async function persistRunContext(runContext: WorkflowRunContext): Promise<void> {
  await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
    execution: createWorkflowExecution({ id: runContext.executionId, workflowId: runContext.workflowId }),
  });
  await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });
}

describe('WorkflowRunContext storage round-trip', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
  });

  afterEach(() => {
    dbContext.cleanup();
  });

  it('builds run contexts with the caller supplied suspension strategy', () => {
    const runContext = buildWorkflowRunContext(
      {
        executionId: 'exec-rc-builder-strategy',
        workflowId: 'wf-test',
        coordinatorSessionId: 'session-builder-strategy',
        source: { kind: 'definition', workflowId: 'wf-test' },
        definitionSnapshot: createWorkflowDefinition({ id: 'wf-test' }),
        inputs: {},
        config: {},
        scope: { type: 'global' },
        triggerPayload: {},
        suspensionStrategy: 'exit-and-redispatch',
      },
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        platformDefaults: { cwd: '/workspace' },
      },
    );

    expect(runContext.suspensionStrategy).toBe('exit-and-redispatch');
  });

  it('persists a materializationSpec set by the builder and retrieves it byte-identically', async () => {
    const materializationSpec = {
      kind: 'workspace-snapshot' as const,
      snapshotId: 'snap-builder-99',
      digest: 'sha256-builder-round-trip',
      sourcePath: 'workflows/builder-test.ts',
    };

    const runContext = buildWorkflowRunContext(
      {
        executionId: 'exec-rc-builder-mat-spec',
        workflowId: 'wf-builder-test',
        coordinatorSessionId: 'session-builder-mat',
        source: { kind: 'path', path: 'workflows/builder-test.ts' },
        inputs: {},
        config: {},
        scope: { type: 'global' },
        triggerPayload: {},
        materializationSpec,
      },
      {
        ...DEFAULT_EXECUTOR_CONFIG,
        platformDefaults: { cwd: '/workspace' },
      },
    );

    expect(runContext.materializationSpec).toEqual(materializationSpec);

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: 'exec-rc-builder-mat-spec',
    });
    expect(fetched).not.toBeNull();
    expect(fetched?.materializationSpec).toEqual(materializationSpec);
  });

  /**
   * Build a minimal valid {@link WorkflowRunContext} for a given execution.
   * @param executionId - Unique execution identifier
   * @param overrides - Optional partial overrides for the context shape
   */
  function buildRunContext(
    executionId: string,
    overrides: Partial<{
      source: 'path' | 'source' | 'definition';
    }> = {},
  ) {
    const sourceKind = overrides.source ?? 'definition';
    const source =
      sourceKind === 'definition'
        ? { kind: 'definition' as const, workflowId: 'wf-test' }
        : sourceKind === 'path'
          ? { kind: 'path' as const, path: 'workflow.ts' }
          : { kind: 'source' as const, filename: 'workflow.ts', source: 'export default ...' };

    const definitionSnapshot =
      sourceKind === 'definition'
        ? { ...createWorkflowDefinition({ id: 'wf-test' }), createdAt: Date.now(), updatedAt: Date.now() }
        : undefined;

    return WorkflowRunContextSchema.parse({
      executionId,
      workflowId: 'wf-test',
      source,
      ...(sourceKind === 'path'
        ? {
            materializationSpec: {
              kind: 'local-directory' as const,
              workspaceId: 'workspace-test',
              rootDigest: 'sha256-workspace-test',
              sourcePath: source.path,
            },
          }
        : {}),
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      inputs: { name: 'value' },
      triggerPayload: { reason: 'manual' },
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-1',
      cancelSubject: `workflow.${executionId}.cancel`,
      env: { NODE_ENV: 'test' },
      createdAt: Date.now(),
    });
  }

  it('persists and retrieves a definition-sourced run context', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-definition';
    const runContext = buildRunContext(executionId);

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched).not.toBeNull();
    expect(fetched?.executionId).toBe(executionId);
    expect(fetched?.workflowId).toBe('wf-test');
    expect(fetched?.source).toEqual({ kind: 'definition', workflowId: 'wf-test' });
    expect(fetched?.coordinatorSessionId).toBe('session-coordinator-1');
    expect(fetched?.cancelSubject).toBe(`workflow.${executionId}.cancel`);
    expect(fetched?.inputs).toEqual({ name: 'value' });
    expect(fetched?.triggerPayload).toEqual({ reason: 'manual' });
    expect(fetched?.env).toEqual({ NODE_ENV: 'test' });
    expect(fetched?.scope).toEqual({ type: 'global' });
  });

  it('persists non-object inputs', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-scalar-input';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      inputs: null,
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.inputs).toBeNull();
  });

  it('persists dispatch metadata for pause and resume routing', async () => {
    const executionId = 'exec-rc-dispatch-metadata';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      dispatchMetadata: { poolId: 'pool-original', route: { kind: 'worker-pool' } },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.dispatchMetadata).toEqual({ poolId: 'pool-original', route: { kind: 'worker-pool' } });
  });

  it('preserves dispatch metadata when a worker checkpoint refreshes run context without it', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-start-preserves-dispatch-metadata';
    await persistRunContext(
      WorkflowRunContextSchema.parse({
        ...buildRunContext(executionId),
        dispatchMetadata: { poolId: 'pool-original', route: { kind: 'worker-pool' } },
      }),
    );

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution: createWorkflowExecution({ id: executionId, workflowId: 'wf-test', status: 'running' }),
      runContext: buildRunContext(executionId),
    });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.dispatchMetadata).toEqual({ poolId: 'pool-original', route: { kind: 'worker-pool' } });
  });

  it('persists and retrieves a path-sourced run context', async () => {
    const executionId = 'exec-rc-path';
    const runContext = buildRunContext(executionId, { source: 'path' });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.source).toEqual({ kind: 'path', path: 'workflow.ts' });
  });

  it('persists and retrieves an inline-source run context', async () => {
    const executionId = 'exec-rc-source';
    const runContext = buildRunContext(executionId, { source: 'source' });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.source).toEqual({ kind: 'source', filename: 'workflow.ts', source: 'export default ...' });
  });

  it('persists the definition snapshot when provided', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-with-snapshot';
    const runContext = buildRunContext(executionId);
    // Attach the definition snapshot
    const withSnapshot = {
      ...runContext,
      definitionSnapshot: {
        ...workflow,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };

    await persistRunContext(withSnapshot);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.definitionSnapshot).toBeDefined();
    expect(fetched?.definitionSnapshot?.id).toBe('wf-test');
    expect(fetched?.definitionSnapshot?.root.nodes).toHaveLength(workflow.root.nodes.length);
  });

  it('rejects definition-sourced run contexts without a definition snapshot', () => {
    expect(() =>
      WorkflowRunContextSchema.parse({
        ...buildRunContext('exec-rc-missing-snapshot'),
        source: { kind: 'definition', workflowId: 'wf-test' },
        definitionSnapshot: undefined,
      }),
    ).toThrow('definitionSnapshot is required');
  });

  it('persists an external-scope run context', async () => {
    const executionId = 'exec-rc-external-scope';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      scope: { type: 'external', kind: 'project', id: 'proj-1' },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.scope).toEqual({ type: 'external', kind: 'project', id: 'proj-1' });
  });

  it('persists a start-supplied artifact reference', async () => {
    const executionId = 'exec-rc-artifact-ref';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      artifactRef: { kind: 'implementation-plan', id: 'artifact-42' },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.artifactRef).toEqual({ kind: 'implementation-plan', id: 'artifact-42' });
  });

  it('returns null for a non-existent execution ID', async () => {
    const { runContext } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: 'exec-rc-missing',
    });
    expect(runContext).toBeNull();
  });

  it('overwrites an existing run context on upsert', async () => {
    const executionId = 'exec-rc-upsert';
    const first = buildRunContext(executionId);
    await persistRunContext(first);

    const second = WorkflowRunContextSchema.parse({
      ...first,
      env: { NODE_ENV: 'production' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext: second });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.env).toEqual({ NODE_ENV: 'production' });
  });

  it('persists the exact worker contribution identity set', async () => {
    const executionId = 'exec-rc-manifest';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      workerManifest: {
        contributionRefs: [
          {
            packageName: '@acme/tools',
            version: '1.0.0',
            entrypoint: 'dist/server.mjs',
            integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
          },
        ],
      },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.workerManifest.contributionRefs).toHaveLength(1);
    expect(fetched?.workerManifest.contributionRefs[0]?.packageName).toBe('@acme/tools');
  });

  it('persists a local-directory materialization spec round-trip', async () => {
    const executionId = 'exec-rc-mat-local';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId, { source: 'path' }),
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'ws-1',
        rootDigest: 'sha256-abc123',
        sourcePath: 'workflow.ts',
      },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.materializationSpec).toEqual({
      kind: 'local-directory',
      workspaceId: 'ws-1',
      rootDigest: 'sha256-abc123',
      sourcePath: 'workflow.ts',
    });
  });

  it('persists a workspace-snapshot materialization spec round-trip', async () => {
    const executionId = 'exec-rc-mat-snapshot';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId, { source: 'path' }),
      materializationSpec: {
        kind: 'workspace-snapshot',
        snapshotId: 'snap-42',
        digest: 'sha256-def456',
        sourcePath: 'workflow.ts',
      },
    });

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.materializationSpec).toEqual({
      kind: 'workspace-snapshot',
      snapshotId: 'snap-42',
      digest: 'sha256-def456',
      sourcePath: 'workflow.ts',
    });
  });

  it('omits materializationSpec for definition-sourced run contexts', async () => {
    const executionId = 'exec-rc-no-mat-spec';
    const runContext = buildRunContext(executionId);

    await persistRunContext(runContext);

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.materializationSpec).toBeUndefined();
  });

  it('rejects absolute sourcePath in a materialization spec', () => {
    expect(() =>
      WorkflowRunContextSchema.parse({
        ...buildRunContext('exec-rc-abs-source-path', { source: 'path' }),
        materializationSpec: {
          kind: 'local-directory',
          workspaceId: 'ws-1',
          rootDigest: 'sha256-abc',
          sourcePath: '/absolute/path/workflow.ts',
        },
      }),
    ).toThrow('sourcePath must be relative');
  });
});
