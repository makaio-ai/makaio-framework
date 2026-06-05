import type { JsonValue, WorkflowIterateChainNode, WorkflowSequenceNode } from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import { cancelFrame, completeFrame, failFrame, startFrame } from './node-execution.js';
import type { PrimitiveExpressionContext, RuntimeContext } from './runtime-context.js';
import type { ItemSettled } from './iterate-node.js';
import { evaluateCollection, extractLastBodyOutput } from './iterate-helpers.js';

// ─────────────────────────────────────────────────────────────
// Iterate-chain output type
// ─────────────────────────────────────────────────────────────

/**
 * Output produced by a completed `iterate-chain` node.
 *
 * Contains one entry per collection item in collection order.
 * The sequential execution order is preserved; each item's output
 * was available as `previous` for the next item's body execution.
 */
export interface IterateChainOutput {
  /** Ordered array of per-item outcomes in collection order. */
  readonly items: ItemSettled[];
}

// ─────────────────────────────────────────────────────────────
// Iterate-chain node executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute an `iterate-chain` node by running the body sequence once per
 * collection item in strict sequential order.
 *
 * **Chain semantics:**
 * Unlike `iterate` (which runs concurrently), `iterate-chain` processes items
 * one at a time. Each item's body execution receives the previous item's
 * frame output as `previous` in its expression context, enabling
 * accumulator/pipeline patterns.
 *
 * **Collection evaluation:**
 * The `collection` jexl expression is evaluated against the incoming
 * expression context to produce an array. Each element becomes an `item`
 * for one sequential body execution.
 *
 * **Expression context per item:**
 * - `item`: the current collection element
 * - `index`: the zero-based position in the collection
 * - `previous`: the output from the previous item's body (absent for the first item)
 *
 * **Frame tracking:**
 * The iterate-chain container frame is created by the sequence loop in
 * `primitive-runtime.ts` before `executeNode` is called. Its `frameId` and
 * `path` are forwarded here as `parentFrameId`/`parentPath`. Each item body
 * execution gets its own child frame with `iteration` = item index.
 *
 * **Failure semantics:**
 * If an item's body fails, iteration stops immediately and the node fails
 * with that item's error. This preserves pipeline correctness — subsequent
 * items would have received a missing `previous` from a failed execution.
 *
 * **Output:**
 * The `IterateChainOutput.items` array contains the settled state of each
 * item that was executed (items after a failure are not included).
 * @param node - The iterate-chain node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param executeSequenceFn - Injected sequence executor (breaks circular dependency).
 * @param parentFrameId - Frame ID of the iterate-chain container frame.
 * @param parentPath - Frame-ID path of ancestor frames (including the container).
 * @returns Terminal execution outcome for the iterate-chain node as a whole.
 */
export async function executeIterateChainNode(
  node: WorkflowIterateChainNode,
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
  const collectionResult = evaluateCollection(node.id, 'iterate-chain', node.collection, expressionCtx);
  if (!Array.isArray(collectionResult)) {
    return collectionResult;
  }
  const collection = collectionResult;

  // ── 2. Empty collection — trivially complete with empty items ──────────
  if (collection.length === 0) {
    return { status: 'completed', output: buildIterateChainOutput([]) };
  }

  // ── 3. Sequential iteration with chained previous output ───────────────
  const settled: ItemSettled[] = [];
  let previous: JsonValue | undefined;

  for (let index = 0; index < collection.length; index++) {
    if (ctx.signal.aborted) {
      return { status: 'cancelled' };
    }

    const item = collection[index];
    const result = await runChainItem(
      item,
      index,
      previous,
      node,
      ctx,
      expressionCtx,
      executeSequenceFn,
      parentFrameId,
      parentPath,
    );

    settled.push(result);

    switch (result.status) {
      case 'fulfilled': {
        // Carry the fulfilled value forward as `previous` for the next item.
        previous = result.value;
        break;
      }
      case 'rejected': {
        // Chain fails immediately on item failure — subsequent items would
        // receive a missing `previous` from a failed execution.
        return { status: 'failed', error: result.reason };
      }
      case 'cancelled': {
        return { status: 'cancelled' };
      }
    }
  }

  return { status: 'completed', output: buildIterateChainOutput(settled) };
}

// ─────────────────────────────────────────────────────────────
// Single chain item runner
// ─────────────────────────────────────────────────────────────

/**
 * Run the iterate-chain body once for a single collection item.
 *
 * Creates a child frame with `iteration = index` so the GUI can track
 * per-item state independently. Injects `item`, `index`, and `previous`
 * into the expression context so body nodes can reference the current
 * collection element and the preceding item's output.
 * @param item - The collection item for this iteration.
 * @param index - Zero-based index of this item in the collection.
 * @param previous - Output from the previous item's body, if any.
 * @param node - The iterate-chain node (for ID and body reference).
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression evaluation context to extend with item context.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the iterate-chain container frame.
 * @param parentPath - Frame-ID path of the iterate-chain container (inclusive).
 * @returns Settled outcome for this item.
 */
async function runChainItem(
  item: unknown,
  index: number,
  previous: JsonValue | undefined,
  node: WorkflowIterateChainNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<ItemSettled> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  // Extend the expression context with item-level and chain-level variables.
  const itemCtx: PrimitiveExpressionContext = {
    ...expressionCtx,
    item,
    index,
    ...(previous !== undefined && { previous }),
  };

  // Create a dedicated frame for this item iteration.
  const frame = ctx.createFrame({
    nodeId: node.id,
    nodeType: 'iterate-chain',
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
      // output value. Extract the last body node's output from the frame registry
      // so it can be passed as `previous` to the next item.
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
 * Build an {@link IterateChainOutput} record from the settled item array.
 * @param settled - Per-item settled outcomes in collection order.
 * @returns JSON-serializable iterate-chain output.
 */
function buildIterateChainOutput(settled: ItemSettled[]): IterateChainOutput {
  return { items: settled };
}
