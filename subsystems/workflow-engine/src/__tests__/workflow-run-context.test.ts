import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowRunContextSchema } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDb, createWorkflowDefinition, type TestDbContext } from './shared.js';

describe('WorkflowRunContext storage round-trip', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
  });

  afterEach(() => {
    dbContext.cleanup();
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
          ? { kind: 'path' as const, path: '/workspace/workflow.ts' }
          : { kind: 'source' as const, filename: 'workflow.ts', source: 'export default ...' };

    const definitionSnapshot =
      sourceKind === 'definition'
        ? { ...createWorkflowDefinition({ id: 'wf-test' }), createdAt: Date.now(), updatedAt: Date.now() }
        : undefined;

    return WorkflowRunContextSchema.parse({
      executionId,
      workflowId: 'wf-test',
      source,
      ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
      inputs: { name: 'value' },
      triggerPayload: { reason: 'manual' },
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-1',
      cancelSubject: `workflow.${executionId}.cancel`,
      context: {
        repoPath: '/workspace',
        makaioHome: '/home/user/.makaio',
        os: 'darwin',
        arch: 'arm64',
      },
      env: { NODE_ENV: 'test' },
      createdAt: Date.now(),
    });
  }

  it('persists and retrieves a definition-sourced run context', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-definition';
    const runContext = buildRunContext(executionId);

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched).not.toBeNull();
    expect(fetched?.executionId).toBe(executionId);
    expect(fetched?.workflowId).toBe('wf-test');
    expect(fetched?.source).toEqual({ kind: 'definition', workflowId: 'wf-test' });
    expect(fetched?.coordinatorSessionId).toBe('session-coordinator-1');
    expect(fetched?.cancelSubject).toBe(`workflow.${executionId}.cancel`);
    expect(fetched?.context.os).toBe('darwin');
    expect(fetched?.context.arch).toBe('arm64');
    expect(fetched?.inputs).toEqual({ name: 'value' });
    expect(fetched?.triggerPayload).toEqual({ reason: 'manual' });
    expect(fetched?.env).toEqual({ NODE_ENV: 'test' });
    expect(fetched?.scope).toEqual({ type: 'global' });
  });

  it('persists non-object inputs and execution hints', async () => {
    const workflow = createWorkflowDefinition({ id: 'wf-test' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const executionId = 'exec-rc-scalar-input';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      inputs: null,
      executionHints: {
        priority: 'high',
        requirements: { capabilities: ['docker'] },
        providers: { 'github-actions': { pool: 'expensive-runner' } },
      },
    });

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.inputs).toBeNull();
    expect(fetched?.executionHints).toEqual({
      priority: 'high',
      requirements: { capabilities: ['docker'] },
      providers: { 'github-actions': { pool: 'expensive-runner' } },
    });
  });

  it('persists and retrieves a path-sourced run context', async () => {
    const executionId = 'exec-rc-path';
    const runContext = buildRunContext(executionId, { source: 'path' });

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.source).toEqual({ kind: 'path', path: '/workspace/workflow.ts' });
  });

  it('persists and retrieves an inline-source run context', async () => {
    const executionId = 'exec-rc-source';
    const runContext = buildRunContext(executionId, { source: 'source' });

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

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

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext: withSnapshot });

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

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.scope).toEqual({ type: 'external', kind: 'project', id: 'proj-1' });
  });

  it('persists a start-supplied artifact reference', async () => {
    const executionId = 'exec-rc-artifact-ref';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      artifactRef: { kind: 'implementation-plan', id: 'artifact-42' },
    });

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

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
    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext: first });

    const second = WorkflowRunContextSchema.parse({
      ...first,
      env: { NODE_ENV: 'production' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext: second });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.env).toEqual({ NODE_ENV: 'production' });
  });

  it('persists the workerManifest with packages', async () => {
    const executionId = 'exec-rc-manifest';
    const runContext = WorkflowRunContextSchema.parse({
      ...buildRunContext(executionId),
      workerManifest: {
        packages: [{ name: '@acme/tools', importPath: 'node_modules/@acme/tools/dist/server.mjs' }],
      },
    });

    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, { runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId });
    expect(fetched?.workerManifest.packages).toHaveLength(1);
    expect(fetched?.workerManifest.packages[0]?.name).toBe('@acme/tools');
  });
});
