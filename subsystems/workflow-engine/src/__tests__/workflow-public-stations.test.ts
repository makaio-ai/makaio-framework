import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SubagentSubjects, type WorkflowDelegateRoleNode, type WorkflowStationNode } from '@makaio/contracts';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  setupWorkflowExecutorTest,
  teardownWorkflowExecutorTest,
  type WorkflowExecutorTestSetup,
} from './workflow-executor.test-setup.js';
import { createWorkflowDefinition } from './shared.js';

describe('workflow public station subjects', () => {
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

  it('runs stored role-backed stations through the subagent seam', async () => {
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

    const roleStation: WorkflowStationNode = {
      id: 'review',
      type: 'station',
      prompt: 'Review {{ input.title }} for {{ config.repository }}',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-role-station',
      name: 'Public Start Role Station',
      root: {
        id: 'public-start-role-station-root',
        type: 'sequence',
        nodes: [roleStation],
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
        nodeType: 'station',
        status: 'completed',
        output: 'completed:Review the plan for workflow-api',
      }),
    ]);
  });

  it('emits frame.sessionLinked when a role-backed station spawns a child session', async () => {
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

    setup.cleanupFns.push(
      MakaioBus.on(SubagentSubjects.getStatus, (ctx) => {
        ctx.setResult({
          status: 'running',
          childSessionId: `session-${ctx.payload.subagentId}`,
          progress: [],
        });
      }),
    );

    const analyzeStation: WorkflowStationNode = {
      id: 'analyze',
      type: 'station',
      prompt: 'Analyze the plan',
      role: 'reviewer',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-session-linked',
      name: 'Public Session Linked',
      root: {
        id: 'public-session-linked-root',
        type: 'sequence',
        nodes: [analyzeStation],
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

  it('runs stored delegate-role nodes through the public start subject', async () => {
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

    const delegateRole: WorkflowDelegateRoleNode = {
      id: 'review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review {{ ctx.inputs.title }}',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-start-delegate-role',
      name: 'Public Start Delegate Role',
      root: {
        id: 'public-start-delegate-role-root',
        type: 'sequence',
        nodes: [delegateRole],
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
        nodeType: 'delegate-role',
        status: 'completed',
        output: 'completed:Review delegate execution',
      }),
    ]);
  });

  it('emits frame.sessionLinked when a delegate-role node creates a child session', async () => {
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

    const delegateRole: WorkflowDelegateRoleNode = {
      id: 'linked-review-delegate',
      type: 'delegate-role',
      role: 'reviewer',
      prompt: 'Review linked session',
      completion: 'turn',
    };

    const workflow = createWorkflowDefinition({
      id: 'public-delegate-session-linked',
      name: 'Public Delegate Session Linked',
      root: {
        id: 'public-delegate-session-linked-root',
        type: 'sequence',
        nodes: [delegateRole],
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
