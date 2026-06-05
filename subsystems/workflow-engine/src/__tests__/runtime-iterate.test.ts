import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import {
  WorkflowNamespace,
  type JsonValue,
  type StationHandler,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowIterateChainNode,
  type WorkflowIterateNode,
  type WorkflowSequenceNode,
  type WorkflowStationNode,
} from '@makaio/contracts';
import { RuntimeContext } from '../runtime/runtime-context.js';
import { executeIterateNode, type IterateOutput } from '../runtime/iterate-node.js';
import { executeIterateChainNode, type IterateChainOutput } from '../runtime/iterate-chain-node.js';
import { executeSequence } from '../runtime/primitive-runtime.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create a minimal WorkflowDefinition for tests.
 * @param id - Workflow identifier.
 * @returns Minimal definition with an empty root sequence.
 */
function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    root: { id: `${id}__root`, type: 'sequence', nodes: [] },
    scope: { type: 'global' },
  };
}

/**
 * Create a minimal WorkflowExecution for tests.
 * @param workflowId - Workflow identifier.
 * @returns Minimal execution record.
 */
function makeExecution(workflowId: string): WorkflowExecution {
  return {
    id: `exec-${workflowId}`,
    workflowId,
    status: 'running',
    inputs: {},
    startedAt: Date.now(),
    scope: { type: 'global' },
  };
}

/**
 * Create a fresh isolated bus with WorkflowNamespace registered.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  return bus;
}

/**
 * Create a fresh RuntimeContext with an isolated bus.
 * @param handlers - Station handlers keyed by node ID.
 * @param signal - Optional abort signal.
 */
function makeCtx(
  handlers: Record<string, StationHandler>,
  signal: AbortSignal = new AbortController().signal,
): RuntimeContext {
  const bus = makeBus();
  return new RuntimeContext(
    'exec-test',
    'workflow-test',
    makeDefinition('workflow-test'),
    makeExecution('workflow-test'),
    new Map(Object.entries(handlers)),
    bus,
    signal,
  );
}

/** Minimal expression context with no pre-populated frames. */
const emptyExpressionCtx = { inputs: {}, trigger: {}, frames: {}, previousSteps: {} };

/**
 * Build an iterate node whose body contains a single station.
 *
 * The `collection` expression must reference a variable in the expression
 * context (e.g., `"inputs.items"`) or be an inline literal
 * (e.g., `"[1, 2, 3]"` via jexl array literals).
 * @param nodeId - Iterate node identifier.
 * @param stationId - Station node identifier inside the body.
 * @param collection - jexl expression resolving to an array.
 * @param handler - Station handler to register.
 * @param concurrency - Optional concurrency limit.
 * @returns Configured iterate node and handler map.
 */
function makeIterateNode(
  nodeId: string,
  stationId: string,
  collection: string,
  handler: StationHandler,
  concurrency?: number,
): { node: WorkflowIterateNode; handlers: Record<string, StationHandler> } {
  const stationNode: WorkflowStationNode = { id: stationId, type: 'station', prompt: stationId };
  const body: WorkflowSequenceNode = {
    id: `${nodeId}__body`,
    type: 'sequence',
    nodes: [stationNode],
  };
  const node: WorkflowIterateNode = {
    id: nodeId,
    type: 'iterate',
    collection,
    body,
    ...(concurrency !== undefined && { concurrency }),
  };
  return { node, handlers: { [stationId]: handler } };
}

/**
 * Build an iterate-chain node whose body contains a single station.
 * @param nodeId - Iterate-chain node identifier.
 * @param stationId - Station node identifier inside the body.
 * @param collection - jexl expression resolving to an array.
 * @param handler - Station handler to register.
 * @returns Configured iterate-chain node and handler map.
 */
function makeIterateChainNode(
  nodeId: string,
  stationId: string,
  collection: string,
  handler: StationHandler,
): { node: WorkflowIterateChainNode; handlers: Record<string, StationHandler> } {
  const stationNode: WorkflowStationNode = { id: stationId, type: 'station', prompt: stationId };
  const body: WorkflowSequenceNode = {
    id: `${nodeId}__body`,
    type: 'sequence',
    nodes: [stationNode],
  };
  const node: WorkflowIterateChainNode = {
    id: nodeId,
    type: 'iterate-chain',
    collection,
    body,
  };
  return { node, handlers: { [stationId]: handler } };
}

/**
 * Create a container iterate frame and return it alongside its parent path,
 * mirroring how the sequence loop in primitive-runtime.ts calls executeNode.
 * @param ctx - Runtime context.
 * @param nodeId - Iterate node ID.
 * @param nodeType - 'iterate' or 'iterate-chain'.
 * @returns Object with frameId and path.
 */
function makeContainerFrame(
  ctx: RuntimeContext,
  nodeId: string,
  nodeType: 'iterate' | 'iterate-chain',
): { frameId: string; path: string[] } {
  const frame = ctx.createFrame({ nodeId, nodeType, path: [] });
  return { frameId: frame.frameId, path: frame.path };
}

// ─────────────────────────────────────────────────────────────
// Iterate node tests
// ─────────────────────────────────────────────────────────────

describe('executeIterateNode', () => {
  it('runs the body once per collection item and collects outputs', async () => {
    const received: unknown[] = [];
    const { node, handlers } = makeIterateNode('iter-1', 'iter-1__item', 'inputs.items', (ctx) => {
      received.push(ctx.item);
      return `processed-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-1', 'iterate');

    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b', 'c'] } };
    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateOutput;
      expect(output.items).toHaveLength(3);
      expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 'processed-a' });
      expect(output.items[1]).toMatchObject({ status: 'fulfilled', value: 'processed-b' });
      expect(output.items[2]).toMatchObject({ status: 'fulfilled', value: 'processed-c' });
    }
  });

  it('evaluates collection expressions against the documented ctx alias', async () => {
    const received: unknown[] = [];
    const { node, handlers } = makeIterateNode('iter-ctx', 'iter-ctx__item', 'ctx.inputs.items', (ctx) => {
      received.push(ctx.item);
      return `processed-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-ctx', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['x', 'y'] } };
    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('completed');
    expect(received).toEqual(['x', 'y']);
  });

  it('uses the final body station by sequence order when start timestamps tie', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const node: WorkflowIterateNode = {
        id: 'iter-order',
        type: 'iterate',
        collection: 'inputs.items',
        body: {
          id: 'iter-order__body',
          type: 'sequence',
          nodes: [
            { id: 'iter-order__draft', type: 'station', prompt: 'Draft' } as WorkflowStationNode,
            { id: 'iter-order__final', type: 'station', prompt: 'Final' } as WorkflowStationNode,
          ],
        },
      };

      const ctx = makeCtx({
        'iter-order__draft': () => 'draft-output',
        'iter-order__final': () => 'final-output',
      });
      const iterFrame = makeContainerFrame(ctx, 'iter-order', 'iterate');
      const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a'] } };

      const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        const output = outcome.output as IterateOutput;
        expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 'final-output' });
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it('passes item and index to the station handler', async () => {
    const calls: Array<{ item: unknown; index: unknown }> = [];
    const { node, handlers } = makeIterateNode('iter-ctx', 'iter-ctx__item', 'inputs.items', (ctx) => {
      calls.push({ item: ctx.item, index: ctx.index });
      return null;
    });

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-ctx', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['x', 'y'] } };

    await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(calls).toEqual([
      { item: 'x', index: 0 },
      { item: 'y', index: 1 },
    ]);
  });

  it('creates one per-item frame with the correct iteration number', async () => {
    const { node, handlers } = makeIterateNode('iter-frames', 'iter-frames__item', 'inputs.items', () => 'ok');

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-frames', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [10, 20] } };

    await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    // Collect iteration frames for this node ID.
    const iterFrames = ctx.getFramesByNodeId('iter-frames');
    // Should have one frame per item (plus the container frame that was
    // pre-created by makeContainerFrame).
    const itemFrames = iterFrames.filter((f) => f.iteration !== undefined);
    expect(itemFrames).toHaveLength(2);
    const iterations = itemFrames.map((f) => f.iteration).sort();
    expect(iterations).toEqual([0, 1]);
  });

  it('returns completed with empty items for an empty collection', async () => {
    const { node, handlers } = makeIterateNode('iter-empty', 'iter-empty__item', 'inputs.items', () => 'ok');

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-empty', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [] } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateOutput;
      expect(output.items).toHaveLength(0);
    }
  });

  it('fails when the collection expression does not resolve to an array', async () => {
    const { node, handlers } = makeIterateNode('iter-bad-coll', 'iter-bad-coll__item', 'inputs.notAnArray', () => null);

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-bad-coll', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { notAnArray: 'hello' } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('iter-bad-coll');
      expect(outcome.error).toContain('array');
    }
  });

  it('captures item handler failures in the settled output without failing the node', async () => {
    const { node, handlers } = makeIterateNode('iter-partial', 'iter-partial__item', 'inputs.items', (ctx) => {
      if (ctx.item === 'bad') throw new Error('Bad item');
      return `ok-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-partial', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['good', 'bad', 'good2'] } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    // iterate always completes — failures are captured per-item.
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateOutput;
      expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 'ok-good' });
      expect(output.items[1]).toMatchObject({ status: 'rejected', reason: expect.stringContaining('Bad item') });
      expect(output.items[2]).toMatchObject({ status: 'fulfilled', value: 'ok-good2' });
    }
  });

  it('cancels immediately when the outer signal is already aborted', async () => {
    const { node, handlers } = makeIterateNode('iter-aborted', 'iter-aborted__item', 'inputs.items', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'should not complete';
    });

    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const ctx = makeCtx(handlers, abortCtrl.signal);
    const iterFrame = makeContainerFrame(ctx, 'iter-aborted', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [1, 2, 3] } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('cancelled');
  });

  it('respects concurrency limit by processing items in batches', async () => {
    // Track concurrent executions to verify the batch limit.
    let concurrent = 0;
    let maxConcurrent = 0;

    const { node, handlers } = makeIterateNode(
      'iter-conc',
      'iter-conc__item',
      'inputs.items',
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return null;
      },
      2, // concurrency = 2
    );

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-conc', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [1, 2, 3, 4] } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('completed');
    // With concurrency=2 and 4 items, max concurrent must be ≤ 2.
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────
// Iterate-chain node tests
// ─────────────────────────────────────────────────────────────

describe('executeIterateChainNode', () => {
  it('runs the body once per item in sequential order', async () => {
    const order: unknown[] = [];
    const { node, handlers } = makeIterateChainNode('chain-1', 'chain-1__item', 'inputs.items', (ctx) => {
      order.push(ctx.item);
      return `processed-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-1', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b', 'c'] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateChainOutput;
      expect(output.items).toHaveLength(3);
      expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 'processed-a' });
      expect(output.items[1]).toMatchObject({ status: 'fulfilled', value: 'processed-b' });
      expect(output.items[2]).toMatchObject({ status: 'fulfilled', value: 'processed-c' });
    }
    // Verify sequential execution order.
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('passes item, index, and previous to the station handler', async () => {
    const calls: Array<{ item: unknown; index: unknown; previous: unknown }> = [];
    const { node, handlers } = makeIterateChainNode('chain-ctx', 'chain-ctx__item', 'inputs.items', (ctx) => {
      calls.push({ item: ctx.item, index: ctx.index, previous: ctx.previous });
      return `out-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-ctx', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['x', 'y', 'z'] } };

    await executeIterateChainNode(node, ctx, exprCtx, executeSequence, chainFrame.frameId, chainFrame.path);

    // First item: no previous.
    expect(calls[0]).toEqual({ item: 'x', index: 0, previous: undefined });
    // Second item: previous is first item's output.
    expect(calls[1]).toEqual({ item: 'y', index: 1, previous: 'out-x' });
    // Third item: previous is second item's output.
    expect(calls[2]).toEqual({ item: 'z', index: 2, previous: 'out-y' });
  });

  it('chains previous output correctly through all items', async () => {
    // Build an accumulator: each item adds its value to the running total.
    const { node, handlers } = makeIterateChainNode('chain-acc', 'chain-acc__item', 'inputs.items', (ctx) => {
      const prev = typeof ctx.previous === 'number' ? ctx.previous : 0;
      return prev + (ctx.item as number);
    });

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-acc', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [1, 2, 3, 4] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateChainOutput;
      // Cumulative sums: 1, 3, 6, 10.
      expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 1 });
      expect(output.items[1]).toMatchObject({ status: 'fulfilled', value: 3 });
      expect(output.items[2]).toMatchObject({ status: 'fulfilled', value: 6 });
      expect(output.items[3]).toMatchObject({ status: 'fulfilled', value: 10 });
    }
  });

  it('chains the final body station output when start timestamps tie', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    try {
      const node: WorkflowIterateChainNode = {
        id: 'chain-order',
        type: 'iterate-chain',
        collection: 'inputs.items',
        body: {
          id: 'chain-order__body',
          type: 'sequence',
          nodes: [
            { id: 'chain-order__draft', type: 'station', prompt: 'Draft' } as WorkflowStationNode,
            { id: 'chain-order__final', type: 'station', prompt: 'Final' } as WorkflowStationNode,
          ],
        },
      };

      const ctx = makeCtx({
        'chain-order__draft': (ctx) => `draft-${String(ctx.item)}`,
        'chain-order__final': (ctx) => `final-${String(ctx.item)}-${String(ctx.previous ?? 'none')}`,
      });
      const chainFrame = makeContainerFrame(ctx, 'chain-order', 'iterate-chain');
      const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b'] } };

      const outcome = await executeIterateChainNode(
        node,
        ctx,
        exprCtx,
        executeSequence,
        chainFrame.frameId,
        chainFrame.path,
      );

      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        const output = outcome.output as IterateChainOutput;
        expect(output.items[0]).toMatchObject({ status: 'fulfilled', value: 'final-a-none' });
        expect(output.items[1]).toMatchObject({ status: 'fulfilled', value: 'final-b-final-a-none' });
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it('creates one per-item frame with the correct iteration number', async () => {
    const { node, handlers } = makeIterateChainNode('chain-frames', 'chain-frames__item', 'inputs.items', () => 'ok');

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-frames', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b', 'c'] } };

    await executeIterateChainNode(node, ctx, exprCtx, executeSequence, chainFrame.frameId, chainFrame.path);

    const chainFrames = ctx.getFramesByNodeId('chain-frames');
    const itemFrames = chainFrames.filter((f) => f.iteration !== undefined);
    expect(itemFrames).toHaveLength(3);
    const iterations = itemFrames.map((f) => f.iteration).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(iterations).toEqual([0, 1, 2]);
  });

  it('returns completed with empty items for an empty collection', async () => {
    const { node, handlers } = makeIterateChainNode('chain-empty', 'chain-empty__item', 'inputs.items', () => null);

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-empty', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      const output = outcome.output as IterateChainOutput;
      expect(output.items).toHaveLength(0);
    }
  });

  it('fails and stops when an item handler throws', async () => {
    const executed: string[] = [];
    const { node, handlers } = makeIterateChainNode('chain-fail', 'chain-fail__item', 'inputs.items', (ctx) => {
      executed.push(String(ctx.item));
      if (ctx.item === 'bad') throw new Error('Item failed');
      return `ok-${String(ctx.item)}`;
    });

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-fail', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'bad', 'c'] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    // Chain fails on the first failed item.
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('Item failed');
    }
    // Item 'c' must not have been executed after the failure.
    expect(executed).not.toContain('c');
  });

  it('fails when the collection expression does not resolve to an array', async () => {
    const { node, handlers } = makeIterateChainNode(
      'chain-bad-coll',
      'chain-bad-coll__item',
      'inputs.notAnArray',
      () => null,
    );

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-bad-coll', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { notAnArray: 42 } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error).toContain('chain-bad-coll');
      expect(outcome.error).toContain('array');
    }
  });

  it('cancels immediately when the outer signal is already aborted', async () => {
    const { node, handlers } = makeIterateChainNode(
      'chain-aborted',
      'chain-aborted__item',
      'inputs.items',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'should not complete';
      },
    );

    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const ctx = makeCtx(handlers, abortCtrl.signal);
    const chainFrame = makeContainerFrame(ctx, 'chain-aborted', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [1, 2, 3] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('cancelled');
  });

  it('executes items strictly sequentially (never concurrently)', async () => {
    // Verify sequential execution by tracking concurrent active executions.
    let concurrent = 0;
    let maxConcurrent = 0;

    const { node, handlers } = makeIterateChainNode('chain-seq', 'chain-seq__item', 'inputs.items', async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return null;
    });

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-seq', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: [1, 2, 3, 4] } };

    await executeIterateChainNode(node, ctx, exprCtx, executeSequence, chainFrame.frameId, chainFrame.path);

    // Strictly sequential: max concurrent must be 1 at all times.
    expect(maxConcurrent).toBe(1);
  });

  it('passes item and index to jexl when/skip conditions in body nodes', async () => {
    // A body station with a `when` condition that references `index`.
    const executed: number[] = [];
    const { node, handlers } = makeIterateChainNode('chain-when', 'chain-when__item', 'inputs.items', (ctx) => {
      executed.push(ctx.index as number);
      return `out-${String(ctx.index)}`;
    });

    // Override the station's `when` condition on the body node.
    // We do this by mutating the body's nodes array (test-only hack).
    const bodyNode = node.body.nodes[0];
    (bodyNode as { when?: string }).when = 'index % 2 == 0';

    const ctx = makeCtx(handlers);
    const chainFrame = makeContainerFrame(ctx, 'chain-when', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b', 'c', 'd'] } };

    const outcome = await executeIterateChainNode(
      node,
      ctx,
      exprCtx,
      executeSequence,
      chainFrame.frameId,
      chainFrame.path,
    );

    expect(outcome.status).toBe('completed');
    // Only items at even indices (0, 2) should have executed the station.
    expect(executed).toEqual([0, 2]);
  });

  it('iterate node passes item and index to when/skip jexl conditions', async () => {
    const executed: number[] = [];
    const { node, handlers } = makeIterateNode('iter-when', 'iter-when__item', 'inputs.items', (ctx) => {
      executed.push(ctx.index as number);
      return null;
    });

    // Mutate the station's when condition to reference `index` (test-only).
    const bodyNode = node.body.nodes[0];
    (bodyNode as { when?: string }).when = 'index < 2';

    const ctx = makeCtx(handlers);
    const iterFrame = makeContainerFrame(ctx, 'iter-when', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b', 'c', 'd'] } };

    const outcome = await executeIterateNode(node, ctx, exprCtx, executeSequence, iterFrame.frameId, iterFrame.path);

    expect(outcome.status).toBe('completed');
    // Only items at indices 0 and 1 should have executed the station.
    expect(executed.sort()).toEqual([0, 1]);
  });
});

// ─────────────────────────────────────────────────────────────
// Frame path integration tests
// ─────────────────────────────────────────────────────────────

describe('iterate/iterate-chain frame path tracking', () => {
  it('iterate item frames are children of the container frame', async () => {
    const { node, handlers } = makeIterateNode('iter-path', 'iter-path__item', 'inputs.items', () => 'ok');

    const ctx = makeCtx(handlers);
    const containerFrame = makeContainerFrame(ctx, 'iter-path', 'iterate');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b'] } };

    await executeIterateNode(node, ctx, exprCtx, executeSequence, containerFrame.frameId, containerFrame.path);

    const itemFrames = ctx.getFramesByNodeId('iter-path').filter((f) => f.iteration !== undefined);
    for (const frame of itemFrames) {
      // Each item frame's parentFrameId should be the container frame.
      expect(frame.parentFrameId).toBe(containerFrame.frameId);
      // The frame path should start with the container frame's path.
      expect(frame.path.slice(0, containerFrame.path.length)).toEqual(containerFrame.path);
    }
  });

  it('iterate-chain item frames are children of the container frame', async () => {
    const { node, handlers } = makeIterateChainNode('chain-path', 'chain-path__item', 'inputs.items', () => 'ok');

    const ctx = makeCtx(handlers);
    const containerFrame = makeContainerFrame(ctx, 'chain-path', 'iterate-chain');
    const exprCtx = { ...emptyExpressionCtx, inputs: { items: ['a', 'b'] } };

    await executeIterateChainNode(node, ctx, exprCtx, executeSequence, containerFrame.frameId, containerFrame.path);

    const itemFrames = ctx.getFramesByNodeId('chain-path').filter((f) => f.iteration !== undefined);
    for (const frame of itemFrames) {
      expect(frame.parentFrameId).toBe(containerFrame.frameId);
      expect(frame.path.slice(0, containerFrame.path.length)).toEqual(containerFrame.path);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// end-to-end via executeSequence (full dispatch path)
// ─────────────────────────────────────────────────────────────

describe('iterate and iterate-chain via full dispatch (executeSequence)', () => {
  it('executes an iterate node inside a sequence', async () => {
    const received: JsonValue[] = [];

    // Build a workflow definition with a root sequence containing one iterate node.
    const iterateNode: WorkflowIterateNode = {
      id: 'iter-seq',
      type: 'iterate',
      collection: 'inputs.items',
      body: {
        id: 'iter-seq__body',
        type: 'sequence',
        nodes: [{ id: 'iter-seq__item', type: 'station', prompt: 'iter-seq__item' } as WorkflowStationNode],
      },
    };

    const handler: StationHandler = (ctx) => {
      const val = ctx.item as JsonValue;
      received.push(val);
      return val;
    };

    const bus = makeBus();
    const definition: WorkflowDefinition = {
      id: 'test-wf',
      root: { id: 'test-wf__root', type: 'sequence', nodes: [iterateNode] },
      scope: { type: 'global' },
    };
    const execution: WorkflowExecution = {
      id: 'exec-test',
      workflowId: 'test-wf',
      status: 'running',
      inputs: { items: [1, 2, 3] },
      startedAt: Date.now(),
      scope: { type: 'global' },
    };

    const ctx = new RuntimeContext(
      'exec-test',
      'test-wf',
      definition,
      execution,
      new Map([['iter-seq__item', handler]]),
      bus,
      new AbortController().signal,
    );

    const outcome = await executeSequence(definition.root, ctx, ctx.buildExpressionContext());

    expect(outcome.status).toBe('completed');
    expect(received.sort()).toEqual([1, 2, 3]);
  });

  it('executes an iterate-chain node inside a sequence with chaining', async () => {
    const calls: Array<{ item: unknown; previous: unknown }> = [];

    const chainNode: WorkflowIterateChainNode = {
      id: 'chain-seq',
      type: 'iterate-chain',
      collection: 'inputs.items',
      body: {
        id: 'chain-seq__body',
        type: 'sequence',
        nodes: [{ id: 'chain-seq__item', type: 'station', prompt: 'chain-seq__item' } as WorkflowStationNode],
      },
    };

    const handler: StationHandler = (ctx) => {
      calls.push({ item: ctx.item, previous: ctx.previous });
      return `processed-${String(ctx.item)}`;
    };

    const bus = makeBus();
    const definition: WorkflowDefinition = {
      id: 'test-chain-wf',
      root: { id: 'test-chain-wf__root', type: 'sequence', nodes: [chainNode] },
      scope: { type: 'global' },
    };
    const execution: WorkflowExecution = {
      id: 'exec-chain',
      workflowId: 'test-chain-wf',
      status: 'running',
      inputs: { items: ['a', 'b', 'c'] },
      startedAt: Date.now(),
      scope: { type: 'global' },
    };

    const ctx = new RuntimeContext(
      'exec-chain',
      'test-chain-wf',
      definition,
      execution,
      new Map([['chain-seq__item', handler]]),
      bus,
      new AbortController().signal,
    );

    const outcome = await executeSequence(definition.root, ctx, ctx.buildExpressionContext());

    expect(outcome.status).toBe('completed');
    expect(calls[0]).toEqual({ item: 'a', previous: undefined });
    expect(calls[1]).toEqual({ item: 'b', previous: 'processed-a' });
    expect(calls[2]).toEqual({ item: 'c', previous: 'processed-b' });
  });
});
