import type { JsonValue, WorkflowFrameState, WorkflowIterateNode, WorkflowSequenceNode } from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import { cancelFrame, completeFrame, failFrame, startFrame } from './node-execution.js';
import type { PrimitiveExpressionContext, RuntimeContext } from './runtime-context.js';
import { evaluateCollection, extractLastBodyOutput } from './iterate-helpers.js';
import { findReusableResumeFrame } from './resume-frames.js';
import { linkSignals } from './signal-helpers.js';

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
  | { readonly status: 'fulfilled'; readonly value?: JsonValue }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'paused'; readonly pausedAtGateId: string; readonly pausedAtFrameId: string };

/**
 * Build a JSON-safe fulfilled item outcome.
 * @param value - Optional JSON output for the item body.
 * @returns Fulfilled item outcome without undefined properties.
 */
export function fulfilledItem(value?: JsonValue): ItemSettled {
  return { status: 'fulfilled', ...(value !== undefined ? { value } : {}) };
}

/** Item frame statuses that can be reused while redispatching a parked iterate node. */
const ITEM_RESUME_STATUSES = new Set<WorkflowFrameState['status']>(['completed', 'running']);

/** Cancellation source signals needed to decide whether an item frame remains resumable. */
interface ItemCancellationOptions {
  /** Execution-level cancellation signal. */
  readonly outerSignal: AbortSignal;
  /** Internal signal used only to stop sibling items after an item parks. */
  readonly pauseSignal?: AbortSignal;
}

/**
 * Whether an item frame should remain running after a cancellation outcome.
 *
 * Pause-triggered sibling aborts are not terminal workflow cancellation. They
 * checkpoint the iterate node so a later redispatch can reuse already-completed
 * child frames under the same item parent frame.
 * @param frame - Item frame whose terminal transition is being considered.
 * @param options - Cancellation source signals for this iterate run.
 * @returns True when the item frame must stay resumable.
 */
function shouldKeepItemFrameRunningOnCancel(frame: WorkflowFrameState, options: ItemCancellationOptions): boolean {
  return frame.status === 'running' && options.pauseSignal?.aborted === true && !options.outerSignal.aborted;
}

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

  // When any item's body paused at a gate, surface the first paused outcome so
  // the enclosing sequence can exit cleanly without completing the iterate node.
  const paused = settled.find((item): item is Extract<ItemSettled, { status: 'paused' }> => item.status === 'paused');
  if (paused !== undefined) {
    return { status: 'paused', pausedAtGateId: paused.pausedAtGateId, pausedAtFrameId: paused.pausedAtFrameId };
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
  const pauseController = new AbortController();
  const abortSiblingsOnPause = ctx.suspensionStrategy !== 'wait-in-process';
  const itemSignal = abortSiblingsOnPause ? linkSignals(ctx.signal, pauseController.signal) : ctx.signal;
  const itemCtx = itemSignal === ctx.signal ? ctx : ctx.withSignal(itemSignal);
  const cancellationOptions: ItemCancellationOptions = {
    outerSignal: ctx.signal,
    ...(abortSiblingsOnPause ? { pauseSignal: pauseController.signal } : {}),
  };

  if (batchSize === 0) {
    // Unlimited concurrency: launch all items at once.
    const promises = collection.map((item, index) =>
      runItem(
        item,
        index,
        node,
        itemCtx,
        expressionCtx,
        executeSequenceFn,
        parentFrameId,
        parentPath,
        cancellationOptions,
      ),
    );
    return Promise.all(
      abortSiblingsOnPause ? promises.map((promise) => abortSiblingsWhenPaused(promise, pauseController)) : promises,
    );
  }

  // Bounded concurrency: process in sequential batches.
  const settled: ItemSettled[] = new Array<ItemSettled>(collection.length);
  for (let batchStart = 0; batchStart < collection.length; batchStart += batchSize) {
    if (itemCtx.signal.aborted) {
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
        runItem(
          collection[i],
          i,
          node,
          itemCtx,
          expressionCtx,
          executeSequenceFn,
          parentFrameId,
          parentPath,
          cancellationOptions,
        ),
      );
    }
    const batchResults = await Promise.all(
      abortSiblingsOnPause
        ? batchPromises.map((promise) => abortSiblingsWhenPaused(promise, pauseController))
        : batchPromises,
    );
    for (let i = 0; i < batchResults.length; i++) {
      settled[batchStart + i] = batchResults[i];
    }
    const paused = batchResults.some((result) => result.status === 'paused');
    if (paused) {
      for (let i = batchEnd; i < collection.length; i++) {
        settled[i] = { status: 'cancelled' };
      }
      break;
    }
  }
  return settled;
}

/**
 * Abort in-flight sibling items once a parked gate pauses the iterate node.
 * @param promise - In-flight item execution promise.
 * @param pauseController - Controller shared by item contexts for this iterate run.
 * @returns The original item outcome after applying pause-triggered cancellation.
 */
function abortSiblingsWhenPaused(
  promise: Promise<ItemSettled>,
  pauseController: AbortController,
): Promise<ItemSettled> {
  return promise.then((outcome) => {
    if (outcome.status === 'paused') {
      pauseController.abort();
    }
    return outcome;
  });
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
 * @param cancellationOptions - Signals used to classify item cancellation source.
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
  cancellationOptions: ItemCancellationOptions,
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

  const resumeFrame = findReusableResumeFrame(ctx.resumeFrames, node.id, {
    parentFrameId,
    iteration: index,
    statuses: ITEM_RESUME_STATUSES,
  });
  if (resumeFrame?.status === 'completed') {
    return fulfilledItem(resumeFrame.output);
  }

  // Create a dedicated frame for this item iteration, or reuse the running
  // item frame left behind by a parked descendant gate.
  const frame =
    resumeFrame ??
    ctx.createFrame({
      nodeId: node.id,
      nodeType: 'iterate',
      path: parentPath,
      parentFrameId,
      iteration: index,
    });

  if (ctx.signal.aborted) {
    if (!shouldKeepItemFrameRunningOnCancel(frame, cancellationOptions)) {
      await cancelFrame(frame, ctx);
    }
    return { status: 'cancelled' };
  }

  if (resumeFrame === undefined) {
    await startFrame(frame, ctx);
  }

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
      return fulfilledItem(bodyOutput);
    }
    case 'skipped': {
      // A fully-skipped body sequence is treated as fulfilled with no output.
      await completeFrame(frame, ctx);
      return fulfilledItem();
    }
    case 'cancelled': {
      if (!shouldKeepItemFrameRunningOnCancel(frame, cancellationOptions)) {
        await cancelFrame(frame, ctx);
      }
      return { status: 'cancelled' };
    }
    case 'paused': {
      // The gate already persisted its frame as 'waiting'. Propagate the paused
      // outcome so the iterate node can surface it to its caller.
      return outcome;
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
