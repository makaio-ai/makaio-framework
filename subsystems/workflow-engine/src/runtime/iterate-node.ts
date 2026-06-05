import type { JsonValue, WorkflowIterateNode, WorkflowSequenceNode } from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import { cancelFrame, completeFrame, failFrame, startFrame } from './node-execution.js';
import type { PrimitiveExpressionContext, RuntimeContext } from './runtime-context.js';
import { evaluateCollection, extractLastBodyOutput } from './iterate-helpers.js';

// ─────────────────────────────────────────────────────────────
// Iterate output types
// ─────────────────────────────────────────────────────────────

/**
 * Output produced by a completed `iterate` node.
 *
 * Contains one entry per collection item in collection order.
 * Each entry is the terminal settled state of that item's body execution.
 */
export interface IterateOutput {
  /** Ordered array of per-item outcomes. */
  readonly items: ItemSettled[];
}

/**
 * Terminal settled state for a single collection item execution.
 */
export type ItemSettled =
  | { readonly status: 'fulfilled'; readonly value: JsonValue | undefined }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'cancelled' };

// ─────────────────────────────────────────────────────────────
// Iterate node executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute an `iterate` node by expanding the collection and running the
 * body sequence once per item, with optional concurrency limiting.
 *
 * **Fan-out semantics:**
 * The `collection` jexl expression is evaluated against the current
 * expression context to produce an array. Each element becomes an `item`
 * for one body execution. All executions run concurrently by default;
 * set `concurrency` to limit the number of concurrent executions.
 *
 * **Concurrency batching:**
 * When `concurrency > 0`, items are processed in batches of `concurrency`.
 * Each batch runs fully in parallel; the next batch starts only after the
 * current batch settles. This preserves throughput while bounding resource
 * use.
 *
 * **Frame tracking:**
 * The iterate container frame is created by the sequence loop in
 * `primitive-runtime.ts` before `executeNode` is called. Its `frameId` and
 * `path` are forwarded here as `parentFrameId`/`parentPath`. Each item body
 * execution gets its own child frame with `iteration` = item index.
 *
 * **Output:**
 * The iterate node always completes (never fails due to individual item
 * failures). Item-level failures are captured in the per-item settled
 * state within `IterateOutput.items`. The caller can inspect per-item
 * results to determine aggregate success.
 * @param node - The iterate node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param executeSequenceFn - Injected sequence executor (breaks circular dependency).
 * @param parentFrameId - Frame ID of the iterate container frame.
 * @param parentPath - Frame-ID path of ancestor frames (including the container).
 * @returns Terminal execution outcome for the iterate node as a whole.
 */
export async function executeIterateNode(
  node: WorkflowIterateNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  // ── 1. Evaluate collection expression ──────────────────────────────────
  const collectionResult = evaluateCollection(node.id, 'iterate', node.collection, expressionCtx);
  if (!Array.isArray(collectionResult)) {
    return collectionResult;
  }
  const collection = collectionResult;

  // ── 2. Empty collection — trivially complete with empty items ──────────
  if (collection.length === 0) {
    return { status: 'completed', output: buildIterateOutput([]) };
  }

  // ── 3. Run items concurrently (with optional batching) ──────────────────
  const batchSize = node.concurrency !== undefined && node.concurrency > 0 ? node.concurrency : 0;
  const settled = await runItemsWithConcurrency(
    collection,
    node,
    ctx,
    expressionCtx,
    executeSequenceFn,
    parentFrameId,
    parentPath,
    batchSize,
  );

  if (ctx.signal.aborted && settled.every((s) => s.status === 'cancelled')) {
    return { status: 'cancelled' };
  }

  return { status: 'completed', output: buildIterateOutput(settled) };
}

// ─────────────────────────────────────────────────────────────
// Concurrency-aware item runner
// ─────────────────────────────────────────────────────────────

/**
 * Run all collection items respecting the concurrency limit.
 *
 * When `batchSize === 0` all items are launched concurrently via a single
 * `Promise.all`. When `batchSize > 0`, items are partitioned into batches of
 * `batchSize`; each batch runs fully in parallel but the next batch starts
 * only after the current batch settles.
 * @param collection - Resolved collection items.
 * @param node - The iterate node (for ID reference).
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression evaluation context forwarded to each item body.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the iterate container.
 * @param parentPath - Frame-ID path of the iterate container.
 * @param batchSize - Maximum concurrent items (0 = unlimited).
 * @returns Ordered array of per-item settled outcomes.
 */
async function runItemsWithConcurrency(
  collection: unknown[],
  node: WorkflowIterateNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
  batchSize: number,
): Promise<ItemSettled[]> {
  if (batchSize === 0) {
    // Unlimited concurrency: launch all items at once.
    const promises = collection.map((item, index) =>
      runItem(item, index, node, ctx, expressionCtx, executeSequenceFn, parentFrameId, parentPath),
    );
    return Promise.all(promises);
  }

  // Bounded concurrency: process in sequential batches.
  const settled: ItemSettled[] = new Array<ItemSettled>(collection.length);
  for (let batchStart = 0; batchStart < collection.length; batchStart += batchSize) {
    if (ctx.signal.aborted) {
      // Fill remaining slots with cancelled.
      for (let i = batchStart; i < collection.length; i++) {
        settled[i] = { status: 'cancelled' };
      }
      break;
    }
    const batchEnd = Math.min(batchStart + batchSize, collection.length);
    const batchPromises: Promise<ItemSettled>[] = [];
    for (let i = batchStart; i < batchEnd; i++) {
      batchPromises.push(
        runItem(collection[i], i, node, ctx, expressionCtx, executeSequenceFn, parentFrameId, parentPath),
      );
    }
    const batchResults = await Promise.all(batchPromises);
    for (let i = 0; i < batchResults.length; i++) {
      settled[batchStart + i] = batchResults[i];
    }
  }
  return settled;
}

// ─────────────────────────────────────────────────────────────
// Single item runner
// ─────────────────────────────────────────────────────────────

/**
 * Run the iterate body once for a single collection item.
 *
 * Creates a child frame with `iteration = index` so the GUI can track
 * per-item state independently. Injects `item` and `index` into the
 * expression context so body nodes can reference the current collection element.
 * @param item - The collection item for this iteration.
 * @param index - Zero-based index of this item in the collection.
 * @param node - The iterate node (for ID and body reference).
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression evaluation context to extend with item context.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the iterate container frame.
 * @param parentPath - Frame-ID path of the iterate container (inclusive).
 * @returns Settled outcome for this item.
 */
async function runItem(
  item: unknown,
  index: number,
  node: WorkflowIterateNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<ItemSettled> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  // Extend the expression context with item-level variables.
  const itemCtx: PrimitiveExpressionContext = {
    ...expressionCtx,
    item,
    index,
  };

  // Create a dedicated frame for this item iteration.
  const frame = ctx.createFrame({
    nodeId: node.id,
    nodeType: 'iterate',
    path: parentPath,
    parentFrameId,
    iteration: index,
  });

  if (ctx.signal.aborted) {
    await cancelFrame(frame, ctx);
    return { status: 'cancelled' };
  }

  await startFrame(frame, ctx);

  let outcome: NodeOutcome;
  try {
    outcome = await executeSequenceFn(node.body as WorkflowSequenceNode, ctx, itemCtx, frame.frameId, frame.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failFrame(frame, ctx, message);
    return { status: 'rejected', reason: message };
  }

  switch (outcome.status) {
    case 'completed': {
      // The sequence executor returns { status: 'completed' } without an output
      // because sequences are structural containers that do not carry a single
      // output value. Extract the last body node's output from the frame registry.
      const bodyOutput = extractLastBodyOutput(node, frame.frameId, ctx);
      await completeFrame(frame, ctx, bodyOutput);
      return { status: 'fulfilled', value: bodyOutput };
    }
    case 'skipped': {
      // A fully-skipped body sequence is treated as fulfilled with no output.
      await completeFrame(frame, ctx);
      return { status: 'fulfilled', value: undefined };
    }
    case 'cancelled': {
      await cancelFrame(frame, ctx);
      return { status: 'cancelled' };
    }
    case 'failed': {
      await failFrame(frame, ctx, outcome.error);
      return { status: 'rejected', reason: outcome.error };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Output construction
// ─────────────────────────────────────────────────────────────

/**
 * Build an {@link IterateOutput} record from the settled item array.
 * @param settled - Per-item settled outcomes in collection order.
 * @returns JSON-serializable iterate output.
 */
function buildIterateOutput(settled: ItemSettled[]): IterateOutput {
  return { items: settled };
}
