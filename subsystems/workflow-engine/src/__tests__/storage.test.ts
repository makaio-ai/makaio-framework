import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '../storage/namespace.js';
import { createTestDb, createWorkflowDefinition, createWorkflowExecution, type TestDbContext } from './shared.js';

describe('workflow storage handlers', () => {
  let dbContext: TestDbContext;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    dbContext = await createTestDb();
  });

  afterEach(() => {
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
      projectId: workflow.projectId,
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

  it('lists workflows by scope and project', async () => {
    const defaultWorkflow = createWorkflowDefinition({
      id: 'workflow-default',
      name: 'default-workflow',
      projectId: null,
      scope: 'default',
    });
    const projectWorkflow = createWorkflowDefinition({
      id: 'workflow-project',
      name: 'project-workflow',
      projectId: 'project-1',
      scope: 'project-1',
    });
    const otherWorkflow = createWorkflowDefinition({
      id: 'workflow-other',
      name: 'other-workflow',
      projectId: 'project-2',
      scope: 'project-2',
    });

    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: defaultWorkflow });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: projectWorkflow });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: otherWorkflow });

    const { workflows: defaultOnly } = await MakaioBus.request(WorkflowStorageSubjects.list, {});
    expect(defaultOnly.map((item) => item.id)).toEqual([defaultWorkflow.id]);

    const { workflows: projectScoped } = await MakaioBus.request(WorkflowStorageSubjects.list, {
      projectId: 'project-1',
    });
    const projectIds = projectScoped.map((item) => item.id).sort();

    expect(projectIds).toEqual([defaultWorkflow.id, projectWorkflow.id].sort());
  });

  it('stores and lists workflow executions', async () => {
    const workflow = createWorkflowDefinition({ id: 'workflow-with-exec' });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow });

    const runningExecution = createWorkflowExecution({
      id: 'execution-running',
      workflowId: workflow.id,
      status: 'running',
    });
    const completedExecution = createWorkflowExecution({
      id: 'execution-completed',
      workflowId: workflow.id,
      status: 'completed',
      completedAt: Date.now(),
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
