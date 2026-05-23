import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { eq, sql } from 'drizzle-orm';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { workflowExecutions, workflowExecutionSteps } from '../storage/schema.js';
import { WorkflowExecutionScopeSchema, ExecutionListQuerySchema } from '@makaio/contracts';
import { createTestDb, createWorkflowDefinition, createWorkflowExecution, type TestDbContext } from './shared.js';

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
    expect(ExecutionListQuerySchema.parse({ workflowId: 'wf-1' }).limit).toBe(50);
  });

  it('rejects an empty workflowId filter', () => {
    expect(() => ExecutionListQuerySchema.parse({ workflowId: '' })).toThrow();
  });

  it('accepts explicit limit', () => {
    expect(ExecutionListQuerySchema.parse({ scope: { type: 'global' }, limit: 1 }).limit).toBe(1);
  });

  it('accepts a cursor', () => {
    const result = ExecutionListQuerySchema.parse({
      workflowId: 'wf-1',
      cursor: { startedAt: 1000, id: 'exec-1' },
    });
    expect(result.cursor).toEqual({ startedAt: 1000, id: 'exec-1' });
  });

  it('rejects limit above 500', () => {
    expect(() => ExecutionListQuerySchema.parse({ workflowId: 'wf-1', limit: 501 })).toThrow();
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
    const workflow = createWorkflowDefinition();

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });

    expect(fetched).toMatchObject({
      id: workflow.id,
      name: workflow.name,
      scope: workflow.scope,
    });
    expect(fetched?.createdAt).toEqual(expect.any(Number));
    expect(fetched?.updatedAt).toEqual(expect.any(Number));
    expect(fetched?.updatedAt).toBeGreaterThanOrEqual(fetched?.createdAt ?? 0);
  });

  it('preserves optional definition fields when omitted from an update payload', async () => {
    const workflow = createWorkflowDefinition({
      id: 'workflow-preserve-optionals',
      description: 'Initial description',
      inputs: [{ name: 'summary', type: 'string' }],
      defaultExecutionTargetId: 'target-1',
      triggers: [{ type: 'manual' }],
      canvasLayout: { nodePositions: { 'step-1': { x: 120, y: 80 } } },
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const updated = {
      id: workflow.id,
      name: 'Updated name',
      steps: workflow.steps,
      scope: workflow.scope,
    };
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });

    const { workflow: fetched } = await MakaioBus.request(WorkflowStorageSubjects.get, { id: workflow.id });
    expect(fetched).toMatchObject({
      id: workflow.id,
      name: 'Updated name',
      description: 'Initial description',
      inputs: [{ name: 'summary', type: 'string' }],
      defaultExecutionTargetId: 'target-1',
      triggers: [{ type: 'manual' }],
      canvasLayout: { nodePositions: { 'step-1': { x: 120, y: 80 } } },
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

  it('persists step state changes without rewriting the execution steps snapshot', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-step-state-rows' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({
      id: 'execution-step-state-rows',
      workflowId: workflow.id,
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    await dbContext.db.delete(workflowExecutionSteps).where(eq(workflowExecutionSteps.executionId, execution.id));
    await MakaioBus.request(WorkflowStorageSubjects.updateExecution, {
      executionId: execution.id,
      stepUpdates: {
        plan: {
          kind: 'executable',
          status: 'completed',
          result: 'planned',
          startedAt: 10,
          completedAt: 20,
        },
      },
    });

    const executionRows = await dbContext.db
      .select({ steps: workflowExecutions.steps })
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, execution.id));
    expect(executionRows[0]?.steps.plan?.status).toBe('pending');

    const stepRows = await dbContext.db
      .select()
      .from(workflowExecutionSteps)
      .where(eq(workflowExecutionSteps.executionId, execution.id));
    expect(stepRows.find((row) => row.stepId === 'plan')?.state).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: 'planned',
    });

    const { execution: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    expect(fetched?.steps.plan).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: 'planned',
    });
    expect(fetched?.steps.implement?.status).toBe('pending');
  });

  it('normalizes legacy persisted executable step states without a kind discriminant', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-legacy-step-kind' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({
      id: 'execution-legacy-step-kind',
      workflowId: workflow.id,
    });

    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });
    await dbContext.db.run(sql`
      UPDATE workflow_executions
      SET steps = ${JSON.stringify({
        plan: { status: 'completed', result: 'legacy snapshot' },
        implement: { status: 'pending' },
      })}
      WHERE id = ${execution.id}
    `);
    await dbContext.db.run(sql`
      UPDATE workflow_execution_steps
      SET state = ${JSON.stringify({ status: 'completed', result: 'legacy row' })}
      WHERE execution_id = ${execution.id} AND step_id = 'plan'
    `);

    const { execution: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    expect(fetched?.steps.plan).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: 'legacy row',
    });
    expect(fetched?.steps.implement).toMatchObject({
      kind: 'executable',
      status: 'pending',
    });

    const { executions } = await MakaioBus.request(WorkflowStorageSubjects.listExecutions, {
      workflowId: workflow.id,
    });
    expect(executions[0]?.steps.plan).toMatchObject({
      kind: 'executable',
      status: 'completed',
      result: 'legacy row',
    });
  });

  it('applies partial execution updates in a transaction', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-update-transaction' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });
    const execution = createWorkflowExecution({
      id: 'execution-update-transaction',
      workflowId: workflow.id,
    });
    await MakaioBus.request(WorkflowStorageSubjects.setExecution, { execution });

    const transactionSpy = vi.spyOn(dbContext.db, 'transaction');
    await MakaioBus.request(WorkflowStorageSubjects.updateExecution, {
      executionId: execution.id,
      status: 'completed',
      stepUpdates: {
        plan: {
          kind: 'executable',
          status: 'completed',
          result: 'planned',
        },
      },
    });

    expect(transactionSpy).toHaveBeenCalled();

    const { execution: fetched } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, {
      executionId: execution.id,
    });
    expect(fetched?.status).toBe('completed');
    expect(fetched?.steps.plan).toMatchObject({ status: 'completed', result: 'planned' });
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

  it('rejects listExecutions when neither workflowId nor scope is provided', async () => {
    await expect(MakaioBus.request(WorkflowStorageSubjects.listExecutions, {})).rejects.toThrow(
      'Either workflowId or scope is required',
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
          limit: 501,
        }),
      ).rejects.toThrow('Execution list limit must be an integer between 1 and 500.');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
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
        stepId: 'plan',
        stepType: 'agent',
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
    expect(spans).toHaveLength(1);
    expect(spans[0]?.stepId).toBe('plan');
    expect(spans[0]?.estimatedCost).toBe(0.01);

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
