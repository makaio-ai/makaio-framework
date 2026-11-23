import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { codeStep, defineWorkflow, WorkflowNamespace, type BuiltWorkflow } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { WorkflowSubjects } from '../namespace.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { runWorkflowOrchestrator } from '../workflow-orchestrator.js';
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
  return runWorkflowOrchestrator({
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

  it('keeps the node error when its failed frame needs a replacement write', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkflowNamespace);
    const storage = await createTestDbForBus(bus);
    const nodeError = 'Original node failure';
    let rejected = false;
    const offWrite = bus.on(
      WorkflowStorageSubjects.setFrame,
      async (ctx) => {
        if (ctx.payload.frame.status === 'failed' && !rejected) {
          rejected = true;
          throw new Error(frameError);
        }
        await ctx.next();
      },
      { priority: 100 },
    );
    try {
      const workflow = defineWorkflow('frame-checkpoint').codeStep('first', () => {
        throw new Error(nodeError);
      });
      const result = await run(bus, workflow);
      expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining(nodeError) });
      const { frames } = await bus.request(WorkflowStorageSubjects.listFrames, { executionId });
      expect(frames).toEqual([
        expect.objectContaining({ nodeId: 'first', status: 'failed', error: expect.stringContaining(nodeError) }),
      ]);
      expect(frames[0]?.error).toContain(frameError);
    } finally {
      offWrite();
      storage.cleanup();
    }
  });
});
