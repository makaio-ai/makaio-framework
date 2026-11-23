import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { type WorkflowAgentStepNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition } from './shared.js';

describe('workflow public agent step subjects', () => {
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

  it('runs stored agent steps through the subagent seam', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload.roleId).toBe('reviewer');
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    const agentStep: WorkflowAgentStepNode = {
      id: 'review',
      type: 'agent-step',
      prompt: 'Review {{ input.title }} for {{ config.repository }}',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-agent-step',
      name: 'Public Start Agent Step',
      root: {
        id: 'public-start-agent-step-root',
        type: 'sequence',
        nodes: [agentStep],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { title: 'the plan' },
      config: { repository: 'workflow-api' },
    });

    await expect(completedPromise).resolves.toBe(executionId);
    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId });

    expect(frames).toEqual([
      expect.objectContaining({
        nodeId: 'review',
        nodeType: 'agent-step',
        status: 'completed',
        output: 'completed:Review the plan for workflow-api',
      }),
    ]);
  });

  it('emits frame.sessionLinked when an agent step spawns a child session', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    const analyzeAgentStep: WorkflowAgentStepNode = {
      id: 'analyze',
      type: 'agent-step',
      prompt: 'Analyze the plan',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-session-linked',
      name: 'Public Session Linked',
      root: {
        id: 'public-session-linked-root',
        type: 'sequence',
        nodes: [analyzeAgentStep],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const sessionLinks: Array<{ frameId: string; sessionId: string }> = [];
    const cleanupLinks = MakaioBus.on(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      sessionLinks.push({ frameId: ctx.payload.frameId, sessionId: ctx.payload.sessionId });
    });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
      });

      await expect(completedPromise).resolves.toBe(executionId);

      expect(sessionLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            frameId: expect.any(String),
            sessionId: expect.stringMatching(/^session-/),
          }),
        ]),
      );
    } finally {
      cleanupLinks();
    }
  });

  it('runs stored agent-step nodes through the public start subject', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        expect(ctx.payload.roleId).toBe('reviewer');
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
          contextMode: 'fresh',
        });
      }),
    );

    const agentStepNode: WorkflowAgentStepNode = {
      id: 'review-delegate',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-agent-step-node',
      name: 'Public Start Agent Step Node',
      root: {
        id: 'public-start-agent-step-node-root',
        type: 'sequence',
        nodes: [agentStepNode],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });

    const completedPromise = new Promise<string>((resolve) => {
      const unsubscribe = MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
        unsubscribe();
        resolve(ctx.payload.executionId);
      });
    });
    const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
      workflowId: workflow.id,
      input: { title: 'delegate execution' },
    });

    await expect(completedPromise).resolves.toBe(executionId);
    const { frames } = await MakaioBus.request(WorkflowStorageSubjects.listFrames, { executionId });

    expect(frames).toEqual([
      expect.objectContaining({
        nodeId: 'review-delegate',
        nodeType: 'agent-step',
        status: 'completed',
        output: 'completed:Review delegate execution',
      }),
    ]);
  });

  it('emits frame.sessionLinked when an agent-step node creates a child session', async () => {
    if (!setup) {
      throw new Error('Workflow executor test setup did not initialize.');
    }

    setup.cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.resolveRole, (ctx) => {
        ctx.setResult({
          adapterName: 'claude-code',
          model: 'workflow-test-model',
        });
      }),
    );

    const linkedAgentStep: WorkflowAgentStepNode = {
      id: 'linked-review-delegate',
      type: 'agent-step',
      role: 'reviewer',
      prompt: 'Review linked session',
      completion: 'turn',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-agent-step-session-linked',
      name: 'Public Agent Step Session Linked',
      root: {
        id: 'public-agent-step-session-linked-root',
        type: 'sequence',
        nodes: [linkedAgentStep],
      },
    });
    await MakaioBus.request(WorkflowSubjects.setDefinition, { workflow });
    const { workflow: storedWorkflow } = await MakaioBus.request(WorkflowSubjects.getDefinition, { id: workflow.id });
    expect(storedWorkflow?.root.nodes[0]).toMatchObject({ completion: 'turn' });

    const sessionLinks: Array<{ frameId: string; sessionId: string }> = [];
    const cleanupLinks = MakaioBus.on(WorkflowSubjects.frame.sessionLinked, (ctx) => {
      sessionLinks.push({ frameId: ctx.payload.frameId, sessionId: ctx.payload.sessionId });
    });

    const terminalPromise = new Promise<{ executionId: string; status: 'completed' | 'failed'; error?: string }>(
      (resolve) => {
        const unsubscribers = [
          MakaioBus.on(WorkflowSubjects.execution.completed, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'completed' });
          }),
          MakaioBus.on(WorkflowSubjects.execution.failed, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'failed', error: ctx.payload.error });
          }),
          MakaioBus.on(WorkflowSubjects.execution.cancelled, (ctx) => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            resolve({ executionId: ctx.payload.executionId, status: 'failed', error: 'cancelled' });
          }),
        ];
      },
    );

    try {
      const { executionId } = await MakaioBus.request(WorkflowSubjects.start, {
        workflowId: workflow.id,
      });

      const terminal = await terminalPromise;
      expect(terminal.executionId).toBe(executionId);
      if (terminal.error !== undefined) {
        throw new Error(terminal.error);
      }
      expect(terminal.status).toBe('completed');

      expect(sessionLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            frameId: expect.any(String),
            sessionId: expect.stringMatching(/^session-/),
          }),
        ]),
      );
    } finally {
      cleanupLinks();
    }
  });
});
