import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { WorkflowExecutionScope } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { createWorkflowDefinition } from './shared.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';

describe('workflow public subjects', () => {
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

  it('returns bounded scope-filtered execution pages through the public listExecutions subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-list-executions',
      name: 'Public List Executions',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const projectScope = {
      type: 'external',
      kind: 'project',
      id: 'project-public-list',
    } satisfies WorkflowExecutionScope;
    const otherScope = { type: 'external', kind: 'project', id: 'project-other' } satisfies WorkflowExecutionScope;

    const projectExecutionIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        scope: projectScope,
        inputs: { index },
      });
      projectExecutionIds.push(executionId);
    }
    for (let index = 0; index < 2; index++) {
      await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
        scope: otherScope,
        inputs: { index },
      });
    }

    const page1 = await MakaioBus.request(WorkflowSubjects.listExecutions, {
      scope: projectScope,
      limit: 2,
    });

    expect(page1.executions).toHaveLength(2);
    const cursorSource = page1.executions.at(-1);
    if (!cursorSource) {
      throw new Error('Expected first execution page to include a cursor source.');
    }

    const page2 = await MakaioBus.request(WorkflowSubjects.listExecutions, {
      scope: projectScope,
      limit: 2,
      cursor: { startedAt: cursorSource.startedAt, id: cursorSource.id },
    });

    const page1Ids = new Set(page1.executions.map((execution) => execution.id));
    const listedProjectExecutions = [...page1.executions, ...page2.executions];

    expect(page2.executions).toHaveLength(2);
    expect(page2.executions.every((execution) => !page1Ids.has(execution.id))).toBe(true);
    expect(listedProjectExecutions.every((execution) => projectExecutionIds.includes(execution.id))).toBe(true);
    expect(listedProjectExecutions.map((execution) => execution.scope)).toEqual([
      projectScope,
      projectScope,
      projectScope,
      projectScope,
    ]);
    expect(new Set(listedProjectExecutions.map((execution) => execution.id)).size).toBe(4);
  });

  it('persists the requested execution scope when starting through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-start-scope-override',
      name: 'Public Start Scope Override',
      scope: { type: 'global' },
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const executionScope = { type: 'session', id: 'session-public-start' } satisfies WorkflowExecutionScope;
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: executionScope,
    });

    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.scope).toEqual(executionScope);
  });

  it('returns execution spans through the public listSpans subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-span-read',
      name: 'Public Span Read',
      steps: [{ id: 'echo', type: 'agent' as const, prompt: 'Echo step' }],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedExecutions: string[] = [];
    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        completedExecutions.push(ctx.payload.executionId);
      }),
    );

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: { type: 'global' },
    });

    await vi.waitFor(() => expect(completedExecutions).toContain(executionId), { timeout: 10_000 });

    const result = await MakaioBus.request(WorkflowSubjects.listSpans, { executionId });

    expect(result.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId,
          stepId: 'echo',
          status: 'completed',
        }),
      ]),
    );
  });
});
