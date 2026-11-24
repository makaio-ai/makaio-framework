import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SubagentSubjects, type WorkflowAgentStepNode, type WorkflowCodeStepNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition } from './shared.js';

describe('workflow public record subjects', () => {
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

  it('finalizes in-process executions as completed when the primitive runtime succeeds', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-completed',
      name: 'Public Runtime Completed',
      root: { id: 'public-runtime-completed-root', type: 'sequence', nodes: [] },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(completedPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.status).toBe('completed');
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('finalizes in-process executions as failed when the primitive runtime fails', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-failed',
      name: 'Public Runtime Failed',
      root: {
        id: 'public-runtime-failed-root',
        type: 'sequence',
        nodes: [
          {
            id: 'missing-handler',
            type: 'code-step',
          } as WorkflowCodeStepNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });

    await expect(failedPromise).resolves.toBe(executionId);
    const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

    expect(execution?.status).toBe('failed');
    expect(execution?.error).toBe('handlerUnavailable');
    expect(execution?.completedAt).toEqual(expect.any(Number));
  });

  it('persists cancellation for in-process executions that have an abort controller', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const agentStep: WorkflowAgentStepNode = {
      id: 'review',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review the work',
    };
    const workflow = createWorkflowDefinition({
      id: 'public-runtime-cancelled',
      name: 'Public Runtime Cancelled',
      root: {
        id: 'public-runtime-cancelled-root',
        type: 'sequence',
        nodes: [agentStep],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const awaitingSubagent = Promise.withResolvers<string>();
    const releaseSubagent = Promise.withResolvers<void>();
    const killedSubagents: string[] = [];
    const cancelledExecutions: string[] = [];
    const cleanups = [
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => ctx.setResult({ adapterName: 'claude-code' })),
      MakaioBus.on(
        SubagentSubjects.await,
        async (ctx) => {
          awaitingSubagent.resolve(ctx.payload.subagentId);
          await releaseSubagent.promise;
          ctx.setResult({ status: 'cancelled' });
        },
        { priority: 10 },
      ),
      MakaioBus.on(
        SubagentSubjects.kill,
        (ctx) => {
          killedSubagents.push(ctx.payload.subagentId);
          ctx.setResult({ killed: true });
        },
        { priority: 10 },
      ),
      MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
        cancelledExecutions.push(ctx.payload.executionId);
      }),
    ];

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
      const subagentId = await awaitingSubagent.promise;

      const cancelResult = await MakaioBus.request(WorkflowSubjects.cancel, {
        executionId,
        reason: 'test cancellation',
      });

      expect(cancelResult.cancelled).toBe(true);
      expect(cancelledExecutions).toEqual([executionId]);
      await vi.waitFor(() => expect(killedSubagents).toEqual([subagentId]));
      const { execution } = await MakaioBus.request(WorkflowSubjects.getExecution, { executionId });

      expect(execution?.status).toBe('cancelled');
      expect(execution?.completedAt).toEqual(expect.any(Number));
    } finally {
      releaseSubagent.resolve();
      for (const cleanup of cleanups) cleanup();
    }
  });

  it('returns execution spans through the public listSpans subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    // Seed an execution via storage so there is a foreign-key anchor for the
    // span rows. The listSpans subject reads from workflow_step_spans keyed by
    // executionId — we can populate it directly without running the full runtime.
    const workflow = createWorkflowDefinition({
      id: 'public-span-read',
      name: 'Public Span Read',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      scope: { type: 'global' },
    });

    // Write a span record directly through the storage subject to verify the
    // public listSpans handler reads and surfaces it correctly.
    await MakaioBus.request(WorkflowStorageSubjects.setSpan, {
      span: {
        executionId,
        frameId: 'frame-echo',
        stepId: 'echo',
        stepType: 'code-step',
        status: 'completed',
      },
    });

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

  it('round-trips execution links through the public link subjects', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-execution-links',
      name: 'Public Execution Links',
      steps: [],
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const { executionId: sourceExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });
    const { executionId: targetExecutionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
    });

    const link = {
      sourceExecutionId,
      targetExecutionId,
      linkType: 'triggered-by' as const,
      metadata: { reason: 'test' },
    };
    const { id } = await MakaioBus.request(WorkflowSubjects.setExecutionLink, { link });
    expect(id).toBe(`${sourceExecutionId}:${targetExecutionId}`);

    const { links } = await MakaioBus.request(WorkflowSubjects.listExecutionLinks, { sourceExecutionId });
    expect(links).toEqual([link]);
  });

  it('returns execution frames through the public listFrames subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    // An empty sequence run persists no frames, so use a code step node that
    // starts a frame in the primitive runtime before failing on the missing
    // in-process handler — the frame rows are persisted either way.
    const workflow = createWorkflowDefinition({
      id: 'public-list-frames',
      name: 'Public List Frames',
      root: {
        id: 'public-list-frames-root',
        type: 'sequence',
        nodes: [
          {
            id: 'frame-producing-code-step',
            type: 'code-step',
          } as WorkflowCodeStepNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    // Wait for the in-process run to finish so the runtime frame store has
    // flushed its persistence tasks before the public read.
    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(failedPromise).resolves.toBe(executionId);

    const { frames } = await MakaioBus.request(WorkflowSubjects.listFrames, { executionId });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.frameId).toBeDefined();
    expect(frames.every((frame) => frame.path.length > 0)).toBe(true);
  });

  it('returns primitive runtime frame spans through the public listSpans subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    const workflow = createWorkflowDefinition({
      id: 'public-runtime-frame-spans',
      name: 'Public Runtime Frame Spans',
      root: {
        id: 'public-runtime-frame-spans-root',
        type: 'sequence',
        nodes: [
          {
            id: 'missing-runtime-handler',
            type: 'code-step',
          } as WorkflowCodeStepNode,
        ],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const failedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, { workflowId: workflow.id });
    await expect(failedPromise).resolves.toBe(executionId);

    const { spans } = await MakaioBus.request(WorkflowSubjects.listSpans, { executionId });

    expect(spans).toEqual([
      expect.objectContaining({
        executionId,
        stepId: 'missing-runtime-handler',
        stepType: 'code-step',
        status: 'failed',
        startedAt: expect.any(Number),
        completedAt: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    ]);
  });
});
