import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  EXECUTION_LIST_DEFAULT_LIMIT,
  EXECUTION_LIST_MAX_LIMIT,
  EXECUTION_LIST_MIN_LIMIT,
  EXECUTIONS_BY_ARTIFACT_REFS_DEFAULT_LIMIT_PER_REF,
  EXECUTIONS_BY_ARTIFACT_REFS_MAX_LIMIT_PER_REF,
  EXECUTIONS_BY_ARTIFACT_REFS_MAX_REFS,
  ExecutionsByArtifactRefsQuerySchema,
  CRON_AUTOMATION_TRIGGER_KIND,
  WorkflowExecutionScopeSchema,
  ExecutionListQuerySchema,
  WorkflowRunContextSchema,
  serializeArtifactRef,
  parseArtifactRef,
  type WorkflowDefinition,
  type WorkflowGateInstance,
} from '@makaio/contracts';
import { createTestDb, createWorkflowDefinition, createWorkflowExecution, type TestDbContext } from './shared.js';
import { workflowExecutionStateEvents } from '../storage/schema.js';

describe('WorkflowExecutionScopeSchema', () => {
  it('parses global scope', () => {
    expect(WorkflowExecutionScopeSchema.parse({ type: 'global' })).toEqual({ type: 'global' });
  });

  it('parses workspace scope', () => {
    expect(WorkflowExecutionScopeSchema.parse({ type: 'workspace', id: 'ws-1' })).toEqual({
      type: 'workspace',
      id: 'ws-1',
    });
  });

  it('parses session scope', () => {
    expect(WorkflowExecutionScopeSchema.parse({ type: 'session', id: 'ses-1' })).toEqual({
      type: 'session',
      id: 'ses-1',
    });
  });

  it('parses external scope', () => {
    expect(WorkflowExecutionScopeSchema.parse({ type: 'external', kind: 'project', id: 'project-1' })).toEqual({
      type: 'external',
      kind: 'project',
      id: 'project-1',
    });
  });

  it('rejects extra fields via strict()', () => {
    expect(() => WorkflowExecutionScopeSchema.parse({ type: 'global', extra: 'field' })).toThrow();
  });
});

describe('ExecutionListQuerySchema', () => {
  it('requires workflowId or scope', () => {
    expect(() => ExecutionListQuerySchema.parse({})).toThrow();
  });

  it('defaults limit to 50', () => {
    expect(ExecutionListQuerySchema.parse({ workflowId: 'wf-1' }).limit).toBe(EXECUTION_LIST_DEFAULT_LIMIT);
  });

  it('rejects an empty workflowId filter', () => {
    expect(() => ExecutionListQuerySchema.parse({ workflowId: '' })).toThrow();
  });

  it('accepts explicit limit', () => {
    expect(ExecutionListQuerySchema.parse({ scope: { type: 'global' }, limit: EXECUTION_LIST_MIN_LIMIT }).limit).toBe(
      EXECUTION_LIST_MIN_LIMIT,
    );
  });

  it('accepts a cursor', () => {
    const result = ExecutionListQuerySchema.parse({
      workflowId: 'wf-1',
      cursor: { startedAt: 1000, id: 'exec-1' },
    });
    expect(result.cursor).toEqual({ startedAt: 1000, id: 'exec-1' });
  });

  it('rejects limit above 500', () => {
    expect(() => ExecutionListQuerySchema.parse({ workflowId: 'wf-1', limit: EXECUTION_LIST_MAX_LIMIT + 1 })).toThrow();
  });

  it('accepts an artifactRef-only filter', () => {
    const result = ExecutionListQuerySchema.parse({ artifactRef: { kind: 'workpiece', id: 'wp-1' } });
    expect(result.artifactRef).toEqual({ kind: 'workpiece', id: 'wp-1' });
    expect(result.limit).toBe(EXECUTION_LIST_DEFAULT_LIMIT);
  });
});

describe('serializeArtifactRef / parseArtifactRef', () => {
  it('round-trips a ref through serialize and parse', () => {
    const ref = { kind: 'workpiece', id: 'wp-123' };
    const key = serializeArtifactRef(ref);
    expect(key).toBe('workpiece:wp-123');
    expect(parseArtifactRef(key)).toEqual(ref);
  });

  it('handles ids containing colons', () => {
    const ref = { kind: 'workpiece', id: 'ns:sub:id' };
    const key = serializeArtifactRef(ref);
    expect(key).toBe('workpiece:ns\\:sub\\:id');
    expect(parseArtifactRef(key)).toEqual(ref);
  });

  it('handles kinds containing colons', () => {
    const ref = { kind: 'system:workpiece', id: 'wp-123' };
    const key = serializeArtifactRef(ref);
    expect(key).toBe('system\\:workpiece:wp-123');
    expect(parseArtifactRef(key)).toEqual(ref);
  });

  it('handles components containing backslashes', () => {
    const ref = { kind: 'work\\piece', id: 'wp\\123' };
    const key = serializeArtifactRef(ref);
    expect(key).toBe('work\\\\piece:wp\\\\123');
    expect(parseArtifactRef(key)).toEqual(ref);
  });

  it('rejects keys without a colon', () => {
    expect(() => parseArtifactRef('nocolon')).toThrow('Invalid artifact ref key');
  });

  it('rejects keys with an empty id portion', () => {
    expect(() => parseArtifactRef('kind:')).toThrow('empty id');
  });

  it('rejects keys with a dangling escape', () => {
    expect(() => parseArtifactRef('kind:id\\')).toThrow('Invalid artifact ref key component');
  });

  it('rejects keys with non-canonical escape sequences', () => {
    expect(() => parseArtifactRef('kind:id\\q')).toThrow('Invalid artifact ref key component');
  });
});

describe('ExecutionsByArtifactRefsQuerySchema', () => {
  it('requires at least one ref', () => {
    expect(() => ExecutionsByArtifactRefsQuerySchema.parse({ refs: [] })).toThrow();
  });

  it('defaults limitPerRef to the contract default', () => {
    const result = ExecutionsByArtifactRefsQuerySchema.parse({
      refs: [{ kind: 'workpiece', id: 'wp-1' }],
    });
    expect(result.limitPerRef).toBe(EXECUTIONS_BY_ARTIFACT_REFS_DEFAULT_LIMIT_PER_REF);
  });

  it('accepts explicit limitPerRef', () => {
    const result = ExecutionsByArtifactRefsQuerySchema.parse({
      refs: [{ kind: 'workpiece', id: 'wp-1' }],
      limitPerRef: 50,
    });
    expect(result.limitPerRef).toBe(50);
  });

  it('rejects limitPerRef above the max', () => {
    expect(() =>
      ExecutionsByArtifactRefsQuerySchema.parse({
        refs: [{ kind: 'workpiece', id: 'wp-1' }],
        limitPerRef: EXECUTIONS_BY_ARTIFACT_REFS_MAX_LIMIT_PER_REF + 1,
      }),
    ).toThrow();
  });

  it('rejects more refs than the max', () => {
    const refs = Array.from({ length: EXECUTIONS_BY_ARTIFACT_REFS_MAX_REFS + 1 }, (_, i) => ({
      kind: 'workpiece',
      id: `wp-${i}`,
    }));
    expect(() => ExecutionsByArtifactRefsQuerySchema.parse({ refs })).toThrow();
  });

  it('accepts refs whose response keys require escaping', () => {
    const result = ExecutionsByArtifactRefsQuerySchema.parse({
      refs: [{ kind: 'work:piece', id: 'wp:1' }],
    });
    expect(result.refs).toEqual([{ kind: 'work:piece', id: 'wp:1' }]);
  });
});

describe('workflow storage handlers', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dbContext.cleanup();
  });

  it('stores and retrieves workflow definitions', async () => {
    const workflow = {
      ...createWorkflowDefinition(),
      artifact: {
        kind: 'workflow-report',
        schemaVersion: 1,
        scope: { level: 'global' },
        statusPath: 'status',
      },
    };

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });

    expect(fetched).toMatchObject({
      id: workflow.id,
      name: workflow.name,
      scope: workflow.scope,
      artifact: workflow.artifact,
    });
  });

  it('round-trips definition-owned metadata through storage', async () => {
    const workflow = {
      ...createWorkflowDefinition({ id: 'workflow-provenance' }),
      source: {
        kind: 'extension' as const,
        extension: 'factory',
        externalId: 'cyberport/ai-factory:.makaio/workflows/intake.ts',
        syncedAt: '2026-06-01T00:00:00.000Z',
        metadata: { repo: 'cyberport/ai-factory' },
      },
      successFinalizerId: 'factory.success-finalizer',
    };

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });

    expect(fetched?.source).toEqual(workflow.source);
    expect(fetched?.successFinalizerId).toBe(workflow.successFinalizerId);
  });

  it('round-trips definition state through storage', async () => {
    const workflow = {
      ...createWorkflowDefinition({ id: 'workflow-state-round-trip' }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    } satisfies WorkflowDefinition;

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });

    expect(fetched?.state).toEqual(workflow.state);
  });

  it('removes definition state when an update payload omits the state contract', async () => {
    const workflow = {
      ...createWorkflowDefinition({ id: 'workflow-state-clear' }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    } satisfies WorkflowDefinition;
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await MakaioBus.request(WorkflowStorageSubjects.set, {
      workflow: {
        id: workflow.id,
        name: workflow.name,
        root: workflow.root,
        scope: workflow.scope,
      },
    });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
    expect(fetched?.state).toBeUndefined();
  });

  it('removes a success finalizer when an update payload omits it', async () => {
    const workflow = {
      ...createWorkflowDefinition({ id: 'workflow-finalizer-clear' }),
      successFinalizerId: 'factory.success-finalizer',
    } satisfies WorkflowDefinition;
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    await MakaioBus.request(WorkflowStorageSubjects.set, {
      workflow: { id: workflow.id, name: workflow.name, root: workflow.root, scope: workflow.scope },
    });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
    expect(fetched?.successFinalizerId).toBeUndefined();
  });

  it('preserves optional definition fields when omitted from an update payload', async () => {
    const workflow = {
      ...createWorkflowDefinition({
        id: 'workflow-preserve-optionals',
        description: 'Initial description',
        triggers: [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '0 9 * * 1' } }],
      }),
      source: {
        kind: 'extension',
        extension: 'factory',
        externalId: 'acme/factory:.makaio/workflows/intake.ts',
        syncedAt: '2026-06-01T00:00:00.000Z',
        metadata: { repo: 'acme/factory' },
      },
    } satisfies WorkflowDefinition;
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const updated: WorkflowDefinition = {
      id: workflow.id,
      name: 'Updated name',
      root: workflow.root,
      scope: workflow.scope,
    };
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
    expect(fetched).toMatchObject({
      id: workflow.id,
      name: 'Updated name',
      description: 'Initial description',
      triggers: [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '0 9 * * 1' } }],
      source: workflow.source,
    });
  });

  it('lists workflows filtered by scope', async () => {
    const globalWorkflow = createWorkflowDefinition({
      id: 'workflow-global',
      name: 'global-workflow',
      scope: { type: 'global' },
    });
    const projectWorkflow = createWorkflowDefinition({
      id: 'workflow-project',
      name: 'project-workflow',
      scope: { type: 'external', kind: 'project', id: 'project-1' },
    });
    const otherWorkflow = createWorkflowDefinition({
      id: 'workflow-other',
      name: 'other-workflow',
      scope: { type: 'external', kind: 'project', id: 'project-2' },
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: globalWorkflow });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: projectWorkflow });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: otherWorkflow });

    // Without a scope filter, all workflows are returned
    const { workflows: allWorkflows } = await MakaioBus.request(WorkflowStorageSubjects.list, {});
    expect(allWorkflows.map((w) => w.id).sort()).toEqual(
      [globalWorkflow.id, projectWorkflow.id, otherWorkflow.id].sort(),
    );

    // Filtered by global scope
    const { workflows: globalOnly } = await MakaioBus.request(WorkflowStorageSubjects.list, {
      scope: { type: 'global' },
    });
    expect(globalOnly.map((w) => w.id)).toEqual([globalWorkflow.id]);

    // Filtered by external project scope
    const { workflows: project1 } = await MakaioBus.request(WorkflowStorageSubjects.list, {
      scope: { type: 'external', kind: 'project', id: 'project-1' },
    });
    expect(project1.map((w) => w.id)).toEqual([projectWorkflow.id]);
  });

  it('stores and lists workflow executions bounded by workflowId', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-with-exec' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const now = Date.now();
    const runningExecution = createWorkflowExecution({
      id: 'execution-running',
      workflowId: workflow.id,
      status: 'running',
      startedAt: now,
    });
    const completedExecution = createWorkflowExecution({
      id: 'execution-completed',
      workflowId: workflow.id,
      status: 'completed',
      startedAt: now + 1,
      completedAt: now + 2,
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: runningExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: completedExecution });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: runningExecution.id,
    });
    expect(execution?.status).toBe('running');

    const { executions: byWorkflow } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
    });
    expect(byWorkflow).toHaveLength(2);

    const { executions: completedOnly } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      status: 'completed',
    });
    expect(completedOnly.map((item) => item.id)).toEqual([completedExecution.id]);
  });

  it('round-trips the execution artifactRef through storage', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-artifact-ref' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({
      id: 'execution-artifact-ref',
      workflowId: workflow.id,
      artifactRef: { kind: 'workpiece', id: 'wp-1' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    const { execution: stored } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    expect(stored?.artifactRef).toEqual({ kind: 'workpiece', id: 'wp-1' });
  });

  it('stores execution start and run context in one storage request', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-execution-start' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-start-atomic', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-atomic',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });

    const result = await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });

    expect(result).toEqual({ id: execution.id, executionId: execution.id });
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id }),
    ).resolves.toEqual(expect.objectContaining({ execution: expect.objectContaining({ id: execution.id }) }));
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId: execution.id }),
    ).resolves.toEqual(expect.objectContaining({ runContext: expect.objectContaining({ executionId: execution.id }) }));
  });

  it('stores execution start, run context, and initial state in one storage request', async () => {
    const workflow = {
      ...createWorkflowDefinition({ id: 'workflow-execution-start-state' }),
      state: {
        schema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        },
        initial: { count: 0 },
      },
    } satisfies WorkflowDefinition;
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-start-with-state', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-state',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution,
      runContext,
      initialState: workflow.state.initial,
    });

    const { state } = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId: execution.id });
    const stateEvents = await dbContext.db
      .select()
      .from(workflowExecutionStateEvents)
      .where(eq(workflowExecutionStateEvents.executionId, execution.id));

    expect(state).toEqual({ executionId: execution.id, sequence: 0, value: { count: 0 } });
    expect(stateEvents).toEqual([
      expect.objectContaining({
        executionId: execution.id,
        sequence: 0,
        patch: [],
        value: { count: 0 },
      }),
    ]);
  });

  it('stores execution start and provenance links in one storage request', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-execution-start-links' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const sourceExecution = createWorkflowExecution({
      id: 'execution-start-link-source',
      workflowId: workflow.id,
      status: 'completed',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: sourceExecution });

    const execution = createWorkflowExecution({ id: 'execution-start-link-target', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-links',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });
    const link = {
      sourceExecutionId: sourceExecution.id,
      targetExecutionId: execution.id,
      linkType: 'rerun-of' as const,
      metadata: { mode: 'snapshot' },
    };

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
      execution,
      runContext,
      executionLinks: [link],
    });

    const { links } = await MakaioBus.request(WorkflowStorageSubjects.listExecutionLinks, {
      sourceExecutionId: sourceExecution.id,
    });
    expect(links).toEqual([link]);
  });

  it('rolls back execution start when an atomic provenance link is invalid', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-execution-start-link-rollback' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-start-link-rollback', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-link-rollback',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
        execution,
        runContext,
        executionLinks: [
          {
            sourceExecutionId: 'missing-source-execution',
            targetExecutionId: execution.id,
            linkType: 'rerun-of',
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id }),
    ).resolves.toEqual({ execution: null });
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId: execution.id }),
    ).resolves.toEqual({ runContext: null });
  });

  it('rejects atomic provenance links targeting a different execution', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-execution-start-link-target-mismatch' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const sourceExecution = createWorkflowExecution({
      id: 'execution-start-link-target-source',
      workflowId: workflow.id,
      status: 'completed',
    });
    const unrelatedTarget = createWorkflowExecution({
      id: 'execution-start-link-target-unrelated',
      workflowId: workflow.id,
      status: 'completed',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: sourceExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: unrelatedTarget });

    const execution = createWorkflowExecution({ id: 'execution-start-link-target-mismatch', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-link-target-mismatch',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, {
        execution,
        runContext,
        executionLinks: [
          {
            sourceExecutionId: sourceExecution.id,
            targetExecutionId: unrelatedTarget.id,
            linkType: 'rerun-of',
          },
        ],
      }),
    ).rejects.toThrow('setExecutionStart requires executionLinks.targetExecutionId to match execution.id');
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId: execution.id }),
    ).resolves.toEqual({ execution: null });
  });

  it('initializes, reads, and patches workflow state with sequence checks', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-state-sequence' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-state-sequence', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    await MakaioBus.request(WorkflowStorageSubjects.initializeState, {
      executionId: execution.id,
      initialValue: { count: 0 },
    });

    await expect(MakaioBus.request(WorkflowStorageSubjects.getState, { executionId: execution.id })).resolves.toEqual({
      state: { executionId: execution.id, sequence: 0, value: { count: 0 } },
    });

    const patched = await MakaioBus.request(WorkflowStorageSubjects.patchState, {
      executionId: execution.id,
      expectedSequence: 0,
      nextValue: { count: 1 },
    });

    const stateEvents = await dbContext.db
      .select()
      .from(workflowExecutionStateEvents)
      .where(eq(workflowExecutionStateEvents.executionId, execution.id))
      .orderBy(asc(workflowExecutionStateEvents.sequence));

    expect(patched).toEqual({
      executionId: execution.id,
      sequence: 1,
      patch: [{ op: 'replace', path: '/count', value: 1 }],
      value: { count: 1 },
    });
    expect(stateEvents.map((event) => event.sequence)).toEqual([0, 1]);
    expect(stateEvents[1]).toEqual(
      expect.objectContaining({
        patch: [{ op: 'replace', path: '/count', value: 1 }],
        value: { count: 1 },
      }),
    );
  });

  it('derives workflow state event patches from the accepted value transition', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-state-derived-patch' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-state-derived-patch', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    await MakaioBus.request(WorkflowStorageSubjects.initializeState, {
      executionId: execution.id,
      initialValue: { count: 0 },
    });

    const patched = await MakaioBus.request(WorkflowStorageSubjects.patchState, {
      executionId: execution.id,
      expectedSequence: 0,
      nextValue: { count: 2 },
    });

    const stateEvents = await dbContext.db
      .select()
      .from(workflowExecutionStateEvents)
      .where(eq(workflowExecutionStateEvents.executionId, execution.id))
      .orderBy(asc(workflowExecutionStateEvents.sequence));

    const expectedPatch = [{ op: 'replace', path: '/count', value: 2 }];
    expect(patched).toEqual({
      executionId: execution.id,
      sequence: 1,
      patch: expectedPatch,
      value: { count: 2 },
    });
    expect(stateEvents[1]).toEqual(
      expect.objectContaining({
        patch: expectedPatch,
        value: { count: 2 },
      }),
    );
  });

  it('rejects stale state patch sequence guards', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-state-conflict' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-state-conflict', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    await MakaioBus.request(WorkflowStorageSubjects.initializeState, {
      executionId: execution.id,
      initialValue: { count: 0 },
    });
    await MakaioBus.request(WorkflowStorageSubjects.patchState, {
      executionId: execution.id,
      expectedSequence: 0,
      nextValue: { count: 1 },
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.patchState, {
        executionId: execution.id,
        expectedSequence: 0,
        nextValue: { count: 2 },
      }),
    ).rejects.toThrow('state sequence conflict');
  });

  it('round-trips suspensionStrategy through run context storage', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-suspension-strategy' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-suspension-strategy', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-suspension-strategy',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: now,
      suspensionStrategy: 'exit-and-redispatch',
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });

    const { runContext: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, {
      executionId: execution.id,
    });
    expect(fetched?.suspensionStrategy).toBe('exit-and-redispatch');
  });

  it('round-trips terminal authority through run context storage', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-terminal-authority' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-terminal-authority', workflowId: workflow.id });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: workflow,
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-terminal-authority',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'authority',
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });

    const stored = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId: execution.id });
    expect(stored.runContext?.terminalAuthority).toBe('authority');
  });

  it('atomically retries a run-context snapshot and initial state write', async () => {
    const oldDefinition = createWorkflowDefinition({ id: 'workflow-authority-bootstrap', description: 'old' });
    const loadedDefinition = { ...oldDefinition, description: 'loaded' };
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: oldDefinition });
    const execution = createWorkflowExecution({ id: 'execution-authority-bootstrap', workflowId: oldDefinition.id });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: execution.id,
      workflowId: oldDefinition.id,
      source: { kind: 'definition', workflowId: oldDefinition.id },
      definitionSnapshot: oldDefinition,
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-authority-bootstrap',
      cancelSubject: `workflow.${execution.id}.cancel`,
      env: {},
      createdAt: Date.now(),
      terminalAuthority: 'authority',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext });
    await dbContext.exec(
      sql.raw(`CREATE TRIGGER fail_authority_state_event BEFORE INSERT ON workflow_execution_state_events
      WHEN NEW.execution_id = '${execution.id}' BEGIN SELECT RAISE(ABORT, 'injected state failure'); END`),
    );

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.setRunContext, {
        runContext: { ...runContext, definitionSnapshot: loadedDefinition },
        initialState: { ready: true },
      }),
    ).rejects.toThrow();
    const afterFailure = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId: execution.id });
    const stateAfterFailure = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId: execution.id });
    expect(afterFailure.runContext?.definitionSnapshot?.description).toBe('old');
    expect(stateAfterFailure.state).toBeNull();

    await dbContext.exec(sql.raw('DROP TRIGGER fail_authority_state_event'));
    await MakaioBus.request(WorkflowStorageSubjects.setRunContext, {
      runContext: { ...runContext, definitionSnapshot: loadedDefinition },
      initialState: { ready: true },
    });
    const afterRetry = await MakaioBus.request(WorkflowStorageSubjects.getRunContext, { executionId: execution.id });
    const stateAfterRetry = await MakaioBus.request(WorkflowStorageSubjects.getState, { executionId: execution.id });
    expect(afterRetry.runContext?.definitionSnapshot?.description).toBe('loaded');
    expect(stateAfterRetry.state?.value).toEqual({ ready: true });
  });

  it('rejects execution start snapshots whose ids do not match', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-execution-start-mismatch' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-start-mismatch', workflowId: workflow.id });
    const now = Date.now();
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'different-execution-id',
      workflowId: workflow.id,
      source: { kind: 'definition', workflowId: workflow.id },
      definitionSnapshot: { ...workflow, createdAt: now, updatedAt: now },
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      coordinatorSessionId: 'session-coordinator-mismatch',
      cancelSubject: 'workflow.different-execution-id.cancel',
      env: {},
      createdAt: now,
    });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.setExecutionStart, { execution, runContext }),
    ).rejects.toThrow('setExecutionStart requires execution.id to match runContext.executionId');
    const { execution: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    expect(fetched).toBeNull();
  });

  it('orders executions by startedAt desc and enforces the limit', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-ordered' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({
          id: `exec-ordered-${i}`,
          workflowId: workflow.id,
          startedAt: base + i,
        }),
      });
    }

    const { executions } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      limit: 3,
    });

    expect(executions).toHaveLength(3);
    // Newest first
    expect(executions[0]?.id).toBe('exec-ordered-4');
    expect(executions[1]?.id).toBe('exec-ordered-3');
    expect(executions[2]?.id).toBe('exec-ordered-2');
  });

  it('supports cursor pagination over executions', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-cursor' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({
          id: `exec-cursor-${i}`,
          workflowId: workflow.id,
          startedAt: base + i,
        }),
      });
    }

    const { executions: page1 } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      limit: 2,
    });
    expect(page1.map((e) => e.id)).toEqual(['exec-cursor-3', 'exec-cursor-2']);

    const last = page1[1];
    const { executions: page2 } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      limit: 2,
      cursor: { startedAt: last!.startedAt, id: last!.id },
    });
    expect(page2.map((e) => e.id)).toEqual(['exec-cursor-1', 'exec-cursor-0']);
  });

  it('paginates executions with the same startedAt by descending id', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-cursor-same-started-at' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const startedAt = Date.now();
    for (const id of ['exec-same-timestamp-a', 'exec-same-timestamp-b', 'exec-same-timestamp-c']) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({
          id,
          workflowId: workflow.id,
          startedAt,
        }),
      });
    }

    const { executions: page1 } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      limit: 2,
    });
    expect(page1.map((e) => e.id)).toEqual(['exec-same-timestamp-c', 'exec-same-timestamp-b']);

    const last = page1[1];
    const { executions: page2 } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
      limit: 2,
      cursor: { startedAt: last!.startedAt, id: last!.id },
    });
    expect(page2.map((e) => e.id)).toEqual(['exec-same-timestamp-a']);
  });

  it('rejects listExecutions when neither workflowId, scope, nor artifactRef is provided', async () => {
    await expect(MakaioBus.request(WorkflowStorageSubjects.listExecutions, {})).rejects.toThrow(
      'Either workflowId, scope, or artifactRef is required',
    );
  });

  it('enforces the execution list limit in the storage handler', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-limit-guard' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await expect(
        MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
          workflowId: workflow.id,
          limit: EXECUTION_LIST_MAX_LIMIT + 1,
        }),
      ).rejects.toThrow(
        `Execution list limit must be an integer between ${EXECUTION_LIST_MIN_LIMIT} and ${EXECUTION_LIST_MAX_LIMIT}.`,
      );
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('batch-fetches executions grouped by artifact ref', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-batch-artifact' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const refA = { kind: 'workpiece', id: 'wp-a' };
    const refB = { kind: 'workpiece', id: 'wp-b' };
    const refC = { kind: 'workpiece', id: 'wp-c' };
    const refEscaped = { kind: 'work:piece', id: 'wp:escaped' };

    const now = Date.now();
    const execA1 = createWorkflowExecution({
      id: 'exec-a1',
      workflowId: workflow.id,
      artifactRef: refA,
      startedAt: now - 200,
    });
    const execA2 = createWorkflowExecution({
      id: 'exec-a2',
      workflowId: workflow.id,
      artifactRef: refA,
      startedAt: now - 100,
    });
    const execB1 = createWorkflowExecution({
      id: 'exec-b1',
      workflowId: workflow.id,
      artifactRef: refB,
      startedAt: now,
    });
    const execEscaped = createWorkflowExecution({
      id: 'exec-escaped',
      workflowId: workflow.id,
      artifactRef: refEscaped,
      startedAt: now - 50,
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: execA1 });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: execA2 });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: execB1 });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: execEscaped });

    const { executionsByRef } = await MakaioBus.request(WorkflowStorageSubjects.listExecutionsByArtifactRefs, {
      refs: [refA, refB, refC, refEscaped],
    });

    const keyA = serializeArtifactRef(refA);
    const keyB = serializeArtifactRef(refB);
    const keyC = serializeArtifactRef(refC);
    const keyEscaped = serializeArtifactRef(refEscaped);

    expect(Object.keys(executionsByRef).sort()).toEqual([keyA, keyB, keyEscaped].sort());
    expect(executionsByRef[keyA]!.map((e) => e.id)).toEqual(['exec-a2', 'exec-a1']);
    expect(executionsByRef[keyB]!.map((e) => e.id)).toEqual(['exec-b1']);
    expect(executionsByRef[keyEscaped]!.map((e) => e.id)).toEqual(['exec-escaped']);
    expect(executionsByRef[keyC]).toBeUndefined();
  });

  it('respects limitPerRef in batch artifact ref query', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-batch-limit' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const ref = { kind: 'workpiece', id: 'wp-limited' };
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({
          id: `exec-limited-${i}`,
          workflowId: workflow.id,
          artifactRef: ref,
          startedAt: now - i * 100,
        }),
      });
    }

    const { executionsByRef } = await MakaioBus.request(WorkflowStorageSubjects.listExecutionsByArtifactRefs, {
      refs: [ref],
      limitPerRef: 2,
    });

    const key = serializeArtifactRef(ref);
    expect(executionsByRef[key]).toHaveLength(2);
    expect(executionsByRef[key]![0]!.id).toBe('exec-limited-0');
    expect(executionsByRef[key]![1]!.id).toBe('exec-limited-1');
  });

  it('rejects batch query with empty refs array', async () => {
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.listExecutionsByArtifactRefs, { refs: [] }),
    ).rejects.toThrow();
  });

  it('rejects malformed refs before batch artifact ref query execution', async () => {
    await expect(
      MakaioBus.request(WorkflowStorageSubjects.listExecutionsByArtifactRefs, {
        refs: [{ kind: 'workpiece' }] as never,
      }),
    ).rejects.toThrow('Invalid listExecutionsByArtifactRefs query');
  });

  it('returns stable scope-filtered pages that do not overlap', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-scope-pagination',
      scope: { type: 'external', kind: 'project', id: 'project-1' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
        execution: createWorkflowExecution({
          id: `exec-scope-page-${i}`,
          workflowId: workflow.id,
          startedAt: base + i,
          scope: { type: 'external', kind: 'project', id: 'project-1' },
        }),
      });
    }

    const page1 = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      scope: { type: 'external', kind: 'project', id: 'project-1' },
      limit: 2,
    });
    expect(page1.executions).toHaveLength(2);

    const cursor = page1.executions.at(-1);
    const page2 = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      scope: { type: 'external', kind: 'project', id: 'project-1' },
      cursor: { startedAt: cursor!.startedAt, id: cursor!.id },
      limit: 2,
    });

    // Page 2 must not contain any items from page 1.
    const page1Ids = new Set(page1.executions.map((e) => e.id));
    expect(page2.executions.every((e) => !page1Ids.has(e.id))).toBe(true);
    expect(page2.executions.length).toBeGreaterThan(0);
  });

  it('persists workflow step spans and execution links', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-span-storage' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const execution = createWorkflowExecution({ id: 'execution-span-storage', workflowId: workflow.id });
    const nextExecution = createWorkflowExecution({ id: 'execution-next', workflowId: workflow.id });
    const previousExecution = createWorkflowExecution({ id: 'execution-previous', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: nextExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: previousExecution });

    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId: execution.id,
        frameId: 'frame-plan',
        stepId: 'plan',
        stepType: 'station',
        status: 'completed',
        startedAt: 10,
        completedAt: 20,
        durationMs: 10,
        inputTokens: 12,
        outputTokens: 5,
        estimatedCost: 0.01,
        toolCallCount: 2,
        input: '{"prompt":"Plan"}',
        output: '{"verdict":"ok"}',
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId: execution.id,
        frameId: 'frame-review',
        stepId: 'review',
        stepType: 'station',
        status: 'completed',
        startedAt: 30,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId: execution.id,
        frameId: 'frame-implement',
        stepId: 'implement',
        stepType: 'station',
        status: 'completed',
        startedAt: 20,
      },
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecutionLink, {
      link: {
        sourceExecutionId: execution.id,
        targetExecutionId: nextExecution.id,
        linkType: 'triggered-by',
        metadata: { subject: 'github.issue.labeled' },
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecutionLink, {
      link: {
        sourceExecutionId: previousExecution.id,
        targetExecutionId: execution.id,
        linkType: 'triggered-by',
      },
    });

    const { spans } = await MakaioBus.request(WorkflowStorageSubjects.listSpans, { executionId: execution.id });
    expect(spans.map((span) => span.stepId)).toEqual(['plan', 'implement', 'review']);
    expect(spans[0]?.stepId).toBe('plan');
    expect(spans[0]?.estimatedCost).toBe(0.01);

    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId: execution.id,
        frameId: 'frame-review-1',
        stepId: 'repeat-review',
        stepType: 'station',
        status: 'completed',
        startedAt: 40,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId: execution.id,
        frameId: 'frame-review-2',
        stepId: 'repeat-review',
        stepType: 'station',
        status: 'completed',
        startedAt: 50,
      },
    });

    const { spans: repeatedFrameSpans } = await MakaioBus.request(WorkflowStorageSubjects.listSpans, {
      executionId: execution.id,
    });
    expect(repeatedFrameSpans.filter((span) => span.stepId === 'repeat-review').map((span) => span.frameId)).toEqual([
      'frame-review-1',
      'frame-review-2',
    ]);

    const { links } = await MakaioBus.request(WorkflowStorageSubjects.listExecutionLinks, {
      sourceExecutionId: execution.id,
    });
    expect(links).toEqual([
      {
        sourceExecutionId: execution.id,
        targetExecutionId: nextExecution.id,
        linkType: 'triggered-by',
        metadata: { subject: 'github.issue.labeled' },
      },
    ]);

    const { links: targetLinks } = await MakaioBus.request(WorkflowStorageSubjects.listExecutionLinks, {
      targetExecutionId: execution.id,
    });
    expect(targetLinks).toEqual([
      {
        sourceExecutionId: previousExecution.id,
        targetExecutionId: execution.id,
        linkType: 'triggered-by',
      },
    ]);
  });

  it('round-trips explicit null frame output separately from absent output', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-frame-null-output' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-frame-null-output', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    await MakaioBus.request(WorkflowStorageSubjects.setFrame, {
      executionId: execution.id,
      frame: {
        frameId: 'frame-without-output',
        nodeId: 'pending-node',
        nodeType: 'station',
        path: ['frame-without-output'],
        status: 'running',
        attempt: 0,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setFrame, {
      executionId: execution.id,
      frame: {
        frameId: 'frame-null-output',
        nodeId: 'null-node',
        nodeType: 'station',
        path: ['frame-null-output'],
        status: 'completed',
        attempt: 0,
        output: null,
      },
    });

    const { frame: absentOutputFrame } = await MakaioBus.request(WorkflowStorageSubjects.getFrame, {
      frameId: 'frame-without-output',
    });
    const { frame: nullOutputFrame } = await MakaioBus.request(WorkflowStorageSubjects.getFrame, {
      frameId: 'frame-null-output',
    });
    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId: execution.id });

    expect(absentOutputFrame).not.toBeNull();
    expect(Object.hasOwn(absentOutputFrame!, 'output')).toBe(false);
    expect(nullOutputFrame?.output).toBeNull();
    expect(frames.find((frame) => frame.frameId === 'frame-without-output')).not.toHaveProperty('output');
    expect(frames.find((frame) => frame.frameId === 'frame-null-output')?.output).toBeNull();
  });

  it('round-trips explicit null gate resumeData separately from absent resumeData', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-gate-null-resume' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-gate-null-resume', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        executionId: execution.id,
        nodeId: 'waiting-gate',
        frameId: 'frame-waiting-gate',
        schema: {},
        status: 'waiting',
        autoAction: 'reject',
        timeoutMs: null,
        createdAt: 1000,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        executionId: execution.id,
        nodeId: 'null-gate',
        frameId: 'frame-null-gate',
        schema: {},
        status: 'resumed',
        autoAction: 'approve',
        timeoutMs: 5000,
        resumeData: null,
        createdAt: 1000,
        resolvedAt: 2000,
      },
    });

    const { gate: absentResumeGate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: execution.id,
      nodeId: 'waiting-gate',
      frameId: 'frame-waiting-gate',
    });
    const { gate: nullResumeGate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: execution.id,
      nodeId: 'null-gate',
      frameId: 'frame-null-gate',
    });
    const { gates } = await MakaioBus.request(WorkflowStorageSubjects.listGateInstances, { executionId: execution.id });

    expect(absentResumeGate).not.toBeNull();
    expect(Object.hasOwn(absentResumeGate!, 'resumeData')).toBe(false);
    expect(absentResumeGate?.autoAction).toBe('reject');
    expect(absentResumeGate?.timeoutMs).toBeNull();
    expect(nullResumeGate?.resumeData).toBeNull();
    expect(nullResumeGate?.autoAction).toBe('approve');
    expect(nullResumeGate?.timeoutMs).toBe(5000);
    expect(gates.find((gate) => gate.nodeId === 'waiting-gate')).not.toHaveProperty('resumeData');
    expect(gates.find((gate) => gate.nodeId === 'null-gate')?.resumeData).toBeNull();
  });

  it('lists waiting gates across executions by status filter', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-gate-inbox' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const waitingExecution = createWorkflowExecution({ id: 'execution-gate-inbox-waiting', workflowId: workflow.id });
    const resumedExecution = createWorkflowExecution({ id: 'execution-gate-inbox-resumed', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: waitingExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: resumedExecution });

    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        executionId: waitingExecution.id,
        nodeId: 'inbox-waiting-gate',
        frameId: 'frame-inbox-waiting',
        schema: {},
        status: 'waiting',
        autoAction: 'reject',
        timeoutMs: null,
        createdAt: 1000,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        executionId: resumedExecution.id,
        nodeId: 'inbox-resumed-gate',
        frameId: 'frame-inbox-resumed',
        schema: {},
        status: 'resumed',
        autoAction: 'reject',
        timeoutMs: null,
        createdAt: 2000,
      },
    });

    const { gates } = await MakaioBus.request(WorkflowStorageSubjects.listGateInstances, { status: 'waiting' });

    expect(gates.map((gate) => gate.status)).toEqual(['waiting']);
    expect(gates[0]?.executionId).toBe(waitingExecution.id);
  });

  it('rejects gate instance listing without any filter', async () => {
    await expect(MakaioBus.request(WorkflowStorageSubjects.listGateInstances, {} as never)).rejects.toThrow(
      'Either executionId or status is required',
    );
  });

  it('resolves a waiting gate instance only once', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-gate-atomic-resolve' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-gate-atomic-resolve', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    const waitingGate: WorkflowGateInstance = {
      executionId: execution.id,
      nodeId: 'gate-atomic-resolve',
      frameId: 'frame-gate-atomic-resolve',
      schema: {},
      status: 'waiting',
      autoAction: 'reject',
      timeoutMs: null,
      createdAt: 1000,
    };
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, { gate: waitingGate });

    const firstResponse = await MakaioBus.request(WorkflowStorageSubjects.resolveWaitingGateInstance, {
      gate: {
        ...waitingGate,
        status: 'resumed',
        resumeData: { decision: 'first' },
        reason: 'approved after review',
        resolvedAt: 2000,
      },
    });
    const secondResponse = await MakaioBus.request(WorkflowStorageSubjects.resolveWaitingGateInstance, {
      gate: {
        ...waitingGate,
        status: 'rejected',
        resumeData: { decision: 'second' },
        resolvedAt: 3000,
      },
    });

    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: execution.id,
      nodeId: waitingGate.nodeId,
      frameId: waitingGate.frameId,
    });

    expect(firstResponse).toEqual({ accepted: true });
    expect(secondResponse).toEqual({ accepted: false });
    expect(gate).toEqual({
      ...waitingGate,
      status: 'resumed',
      resumeData: { decision: 'first' },
      reason: 'approved after review',
      resolvedAt: 2000,
    });
  });

  it('restores paused execution and waiting gate state through one storage subject', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-gate-restore-state' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const pausedExecution = {
      ...createWorkflowExecution({
        id: 'execution-gate-restore-state',
        workflowId: workflow.id,
      }),
      status: 'paused',
    } satisfies ReturnType<typeof createWorkflowExecution> & { readonly status: 'paused' };
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, {
      execution: { ...pausedExecution, status: 'running' },
    });

    const waitingGate = {
      executionId: pausedExecution.id,
      nodeId: 'gate-restore-state',
      frameId: 'frame-gate-restore-state',
      schema: {},
      status: 'waiting',
      autoAction: 'reject',
      timeoutMs: 5000,
      createdAt: 1000,
    } satisfies WorkflowGateInstance & { readonly status: 'waiting' };
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        ...waitingGate,
        status: 'resumed',
        resumeData: { decision: 'accepted' },
        resolvedAt: 2000,
      },
    });

    await MakaioBus.request(WorkflowStorageSubjects.restorePausedGateResumeState, {
      execution: pausedExecution,
      gate: waitingGate,
    });

    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: pausedExecution.id,
    });
    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: waitingGate.executionId,
      nodeId: waitingGate.nodeId,
      frameId: waitingGate.frameId,
    });

    expect(execution).toEqual(expect.objectContaining({ id: pausedExecution.id, status: 'paused' }));
    expect(gate).toEqual(waitingGate);
  });

  it('cancels a paused execution and its waiting gates through one storage subject', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-paused-cancel' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({
      id: 'execution-paused-cancel',
      workflowId: workflow.id,
      status: 'paused',
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    const waitingGate = {
      executionId: execution.id,
      nodeId: 'gate-paused-cancel',
      frameId: 'frame-gate-paused-cancel',
      schema: {},
      status: 'waiting',
      autoAction: 'reject',
      timeoutMs: null,
      createdAt: 1000,
    } satisfies WorkflowGateInstance & { readonly status: 'waiting' };
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, { gate: waitingGate });

    const cancelled = await MakaioBus.request(WorkflowStorageSubjects.cancelPausedExecution, {
      executionId: execution.id,
      completedAt: 2000,
      reason: 'review requested cancellation',
    });
    const { execution: persistedExecution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    const { gate } = await MakaioBus.request(WorkflowStorageSubjects.getGateInstance, {
      executionId: waitingGate.executionId,
      nodeId: waitingGate.nodeId,
      frameId: waitingGate.frameId,
    });

    expect(cancelled).toEqual({
      cancelled: true,
      gates: [{ ...waitingGate, status: 'cancelled', resolvedAt: 2000 }],
    });
    expect(persistedExecution).toEqual(
      expect.objectContaining({
        id: execution.id,
        status: 'cancelled',
        completedAt: 2000,
        reason: 'review requested cancellation',
      }),
    );
    expect(gate).toEqual({ ...waitingGate, status: 'cancelled', resolvedAt: 2000 });
  });

  it('lists only finite-timeout waiting gates on paused executions for scheduler rehydration', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-paused-gate-timeouts' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const pausedExecution = createWorkflowExecution({
      id: 'execution-paused-gate-timeout',
      workflowId: workflow.id,
      status: 'paused',
    });
    const runningExecution = createWorkflowExecution({
      id: 'execution-running-gate-timeout',
      workflowId: workflow.id,
      status: 'running',
    });
    const completedExecution = createWorkflowExecution({
      id: 'execution-completed-gate-timeout',
      workflowId: workflow.id,
      status: 'completed',
      completedAt: Date.now(),
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: pausedExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: runningExecution });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution: completedExecution });

    const baseGate = {
      nodeId: 'gate',
      frameId: 'frame',
      schema: {},
      autoAction: 'reject' as const,
      timeoutMs: 1000,
      createdAt: 1000,
    };
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: { ...baseGate, executionId: pausedExecution.id, status: 'waiting' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        ...baseGate,
        executionId: pausedExecution.id,
        nodeId: 'gate-null-timeout',
        timeoutMs: null,
        status: 'waiting',
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: {
        ...baseGate,
        executionId: pausedExecution.id,
        nodeId: 'gate-resumed',
        status: 'resumed',
        resumeData: null,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: { ...baseGate, executionId: runningExecution.id, nodeId: 'gate-running', status: 'waiting' },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setGateInstance, {
      gate: { ...baseGate, executionId: completedExecution.id, nodeId: 'gate-completed', status: 'waiting' },
    });

    const { gates } = await MakaioBus.request(WorkflowStorageSubjects.listPausedGateTimeouts, {});

    expect(gates.map((gate) => gate.nodeId)).toEqual(['gate']);
    expect(gates[0]).toEqual(
      expect.objectContaining({
        executionId: pausedExecution.id,
        status: 'waiting',
        timeoutMs: 1000,
        autoAction: 'reject',
      }),
    );
  });

  it('rejects execution links without existing source and target executions', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-link-fks' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    await expect(
      MakaioBus.request(WorkflowStorageSubjects.setExecutionLink, {
        link: {
          sourceExecutionId: 'missing-source-execution',
          targetExecutionId: 'missing-target-execution',
          linkType: 'triggered-by',
        },
      }),
    ).rejects.toThrow();
  });

  it('requires a source or target filter when listing execution links', async () => {
    const requestSchema = WorkflowStorageNamespace.schemas.listExecutionLinks.request;

    expect(requestSchema.safeParse({}).success).toBe(false);
    await expect(MakaioBus.request(WorkflowStorageSubjects.listExecutionLinks, {})).rejects.toThrow(
      'Either sourceExecutionId or targetExecutionId is required',
    );

    const originalNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await expect(MakaioBus.request(WorkflowStorageSubjects.listExecutionLinks, {})).rejects.toThrow(
        'required to list execution links',
      );
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('lists execution frames in deterministic start order', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-frame-order' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({ id: 'execution-frame-order', workflowId: workflow.id });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    // Insert frame-b first (startedAt: 2), then frame-a (startedAt: 1).
    await MakaioBus.request(WorkflowStorageSubjects.setFrame, {
      executionId: execution.id,
      frame: {
        frameId: 'frame-b',
        nodeId: 'b',
        nodeType: 'station',
        path: ['frame-b'],
        status: 'completed',
        startedAt: 2,
        attempt: 0,
      },
    });
    await MakaioBus.request(WorkflowStorageSubjects.setFrame, {
      executionId: execution.id,
      frame: {
        frameId: 'frame-a',
        nodeId: 'a',
        nodeType: 'station',
        path: ['frame-a'],
        status: 'completed',
        startedAt: 1,
        attempt: 0,
      },
    });

    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId: execution.id });

    expect(frames.map((frame) => frame.frameId)).toEqual(['frame-a', 'frame-b']);
  });

  describe('Lifecycle events', () => {
    const cleanups: Array<() => void> = [];

    afterEach(() => {
      cleanups.forEach((cleanup) => cleanup());
      cleanups.length = 0;
    });

    it('emits definition.created on insert', async () => {
      const handler = vi.fn();
      cleanups.push(MakaioBus.on(WorkflowSubjects.definition.created, (ctx) => handler(ctx.payload)));

      await MakaioBus.request(WorkflowStorageSubjects.set, {
        workflow: createWorkflowDefinition({ id: 'lc-wf-1' }),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'lc-wf-1' }));
    });

    it('emits definition.updated on upsert of existing entity', async () => {
      await MakaioBus.request(WorkflowStorageSubjects.set, {
        workflow: createWorkflowDefinition({ id: 'lc-wf-2' }),
      });

      const handler = vi.fn();
      cleanups.push(MakaioBus.on(WorkflowSubjects.definition.updated, (ctx) => handler(ctx.payload)));

      await MakaioBus.request(WorkflowStorageSubjects.set, {
        workflow: createWorkflowDefinition({ id: 'lc-wf-2', description: 'Updated workflow' }),
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'lc-wf-2' }));
    });

    it('emits definition.deleted on removal', async () => {
      await MakaioBus.request(WorkflowStorageSubjects.set, {
        workflow: createWorkflowDefinition({ id: 'lc-wf-3' }),
      });

      const handler = vi.fn();
      cleanups.push(MakaioBus.on(WorkflowSubjects.definition.deleted, (ctx) => handler(ctx.payload)));

      await MakaioBus.request(WorkflowStorageSubjects.delete, { id: 'lc-wf-3' });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ id: 'lc-wf-3' });
    });
  });
});
