import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { codeStep, defineWorkflow, WorkflowNamespace, type BuiltWorkflow } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runCallerLocalWorkflowOrchestrator } from '../workflow-orchestrator.js';
import { createTestDbForBus } from './shared.js';

const executionId = 'exec-frame-checkpoint';
const frameError = 'Injected frame storage failure';

/**
 * Run a workflow through the worker orchestrator and real workflow storage.
 * @param bus - Bus with a registered workflow storage fixture.
 * @param workflow - Workflow under test.
 * @returns The worker's terminal result.
 */
function run(bus: ReturnType<typeof createBusInstance>, workflow: BuiltWorkflow) {
  return runCallerLocalWorkflowOrchestrator({
    call: createTestCall(),
    config: {
      source: { kind: 'definition', workflowId: workflow.id },
      executionId,
      workflowId: workflow.id,
      triggerPayload: {},
      inputs: { items: [1, 2] },
      scope: { type: 'global' },
      busAuth: { kind: 'none' },
      env: {},
      coordinatorSessionId: 'session-1',
      cancelSubject: `workflow.${executionId}.cancel`,
    },
    loaded: workflow,
    bus,
    signal: new AbortController().signal,
  });
}

describe('workflow structural frame diagnostics', () => {
  const detail = 'Leaf diagnostic';
  const fail = (): never => {
    throw new Error(detail);
  };

  it.each([
    {
      kind: 'all-settled parallel',
      workflow: defineWorkflow('frame-checkpoint').parallel('parent', { mode: 'all-settled' }, [
        codeStep('leaf', fail),
      ]),
      failedParents: 1,
      status: 'completed',
    },
    {
      kind: 'fail-fast parallel',
      workflow: defineWorkflow('frame-checkpoint').parallel('parent', { mode: 'fail-fast' }, [codeStep('leaf', fail)]),
      failedParents: 2,
      status: 'failed',
    },
    {
      kind: 'iterate',
      workflow: defineWorkflow('frame-checkpoint').iterate('parent', fail, { collection: 'inputs.items' }),
      failedParents: 2,
      status: 'completed',
    },
    {
      kind: 'iterate-chain',
      workflow: defineWorkflow('frame-checkpoint').iterateChain('parent', [codeStep('leaf', fail)], {
        collection: 'inputs.items',
      }),
      failedParents: 2,
      status: 'failed',
    },
    {
      kind: 'loop',
      workflow: defineWorkflow('frame-checkpoint').loop('parent', [codeStep('leaf', fail)], {
        maxRounds: 1,
        check: 'leaf',
      }),
      failedParents: 2,
      status: 'failed',
    },
  ])('persists the leaf diagnostic in failed $kind frames', async ({ workflow, failedParents, status }) => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const storage = await createTestDbForBus(bus);
    const errors: string[] = [];
    const offFailed = bus.on(WorkflowSubjects.frame.failed, ({ payload }) => {
      if (payload.nodeId === 'parent') errors.push(payload.error);
    });
    try {
      const result = await run(bus, workflow);
      expect(result.status).toBe(status);
      if (result.status === 'failed') expect(result.error).toBe('stepExecutionFailed');
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId });
      const parents = frames.filter((frame) => frame.nodeId === 'parent' && frame.status === 'failed');
      expect(parents.map((frame) => frame.error)).toEqual(Array.from({ length: failedParents }, () => detail));
      expect(errors).toEqual(Array.from({ length: failedParents }, () => 'stepExecutionFailed'));
    } finally {
      offFailed();
      storage.cleanup();
    }
  });
});

describe('workflow frame storage failures', () => {
  it.each([
    { kind: 'parallel', target: 'container' },
    { kind: 'iterate', target: 'container' },
    { kind: 'parallel', target: 'body' },
    { kind: 'iterate', target: 'body' },
    { kind: 'parallel', target: 'body', rejectEnclosingFrame: true },
  ])('drains $kind work in flight after a $target write fails', async ({ kind, target, rejectEnclosingFrame }) => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const storage = await createTestDbForBus(bus);
    const blockedSibling = Promise.withResolvers<void>();
    const siblingStarted = Promise.withResolvers<void>();
    const failedWrite = Promise.withResolvers<void>();
    const order: string[] = [];
    const sibling = async () => {
      siblingStarted.resolve();
      await blockedSibling.promise;
      order.push('sibling completed');
    };
    const builder = defineWorkflow('frame-checkpoint');
    const workflow =
      kind === 'parallel'
        ? builder.parallel('fan-out', { mode: 'all-settled' }, [
            codeStep('first', () => 0),
            codeStep('second', sibling),
          ])
        : builder.iterate('fan-out', ({ index }) => (index === 1 ? sibling() : 0), { collection: 'inputs.items' });
    const offWrite = bus.on(
      WorkflowStorageSubjects.setFrame,
      async (ctx) => {
        const { frame } = ctx.payload;
        if (rejectEnclosingFrame && frame.nodeId === 'fan-out' && frame.status === 'failed') {
          throw new Error('Injected enclosing-frame storage failure');
        }
        const failedContainer =
          frame.nodeId === 'fan-out' &&
          frame.status === 'running' &&
          (frame.iteration === 0 || frame.branchKey === 'first');
        const failedBody = frame.status === 'completed' && frame.output === 0;
        if (target === 'container' ? failedContainer : failedBody) {
          await siblingStarted.promise;
          failedWrite.resolve();
          throw new Error(frameError);
        }
        await ctx.next();
      },
      { priority: 100 },
    );
    const offFailed = bus.on(WorkflowSubjects.execution.failed, () => {
      order.push('execution failed');
    });
    const result = run(bus, workflow);
    try {
      await failedWrite.promise;
      await setImmediate();
      blockedSibling.resolve();
      await expect(result).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining(frameError) });
      expect(order).toEqual(['sibling completed', 'execution failed']);
    } finally {
      blockedSibling.resolve();
      await result.catch(() => undefined);
      offWrite();
      offFailed();
      storage.cleanup();
    }
  });

  it.each([
    'running',
    'completed',
  ])('stores a failed frame when the %s transition cannot be written', async (status) => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const storage = await createTestDbForBus(bus);
    const offWrite = bus.on(
      WorkflowStorageSubjects.setFrame,
      async (ctx) => {
        if (ctx.payload.frame.status === status) throw new Error(frameError);
        await ctx.next();
      },
      { priority: 100 },
    );
    try {
      const workflow = defineWorkflow('frame-checkpoint').codeStep('first', () => 'done');
      await expect(run(bus, workflow)).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining(frameError),
      });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId });
      expect(frames).toEqual([
        expect.objectContaining({ nodeId: 'first', status: 'failed', error: expect.stringContaining(frameError) }),
      ]);
    } finally {
      offWrite();
      storage.cleanup();
    }
  });

  it('keeps the node failure code when its failed frame needs a replacement write', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const storage = await createTestDbForBus(bus);
    const nodeError = 'Original node failure';
    const failedWrites: unknown[] = [];
    const offWrite = bus.on(
      WorkflowStorageSubjects.setFrame,
      async (ctx) => {
        if (ctx.payload.frame.status === 'failed') {
          failedWrites.push(ctx.payload.frame);
          if (failedWrites.length === 1) throw new Error(frameError);
        }
        await ctx.next();
      },
      { priority: 100 },
    );
    const failureEvents: string[] = [];
    const offFailed = bus.on(WorkflowSubjects.frame.failed, ({ payload }) => {
      failureEvents.push(payload.error);
    });
    try {
      const workflow = defineWorkflow('frame-checkpoint').codeStep('first', () => {
        throw new Error(nodeError);
      });
      const result = await run(bus, workflow);
      assert(result.status === 'failed');
      expect(result.error).toContain('stepExecutionFailed');
      expect(result.error).toContain(frameError);
      const { execution } = await bus.request(WorkflowStorageSubjects.getExecution, { executionId });
      expect(execution).toMatchObject({ status: 'failed', error: result.error });
      expect(failureEvents).toEqual(['stepExecutionFailed']);
      expect(failedWrites).toHaveLength(2);
      expect(failedWrites[0]).toMatchObject({ error: nodeError });
      expect(failedWrites[1]).toEqual(failedWrites[0]);
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId });
      expect(frames).toEqual([
        expect.objectContaining({
          nodeId: 'first',
          status: 'failed',
          error: nodeError,
        }),
      ]);
    } finally {
      offFailed();
      offWrite();
      storage.cleanup();
    }
  });
});
