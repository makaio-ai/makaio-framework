import type { JsonValue, WorkflowSequenceNode } from '@makaio/contracts';
import {
  buildPreviousStepsFromFrames,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import {
  cancelFrame,
  completeFrame,
  evaluateNodeCondition,
  executeNode,
  failFrame,
  skipFrame,
  startFrame,
  type NodeOutcome,
} from './node-execution.js';

// ─────────────────────────────────────────────────────────────
// Sequence execution
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a `when` or `skip` condition expression and return the result.
 *
 * On evaluation failure, creates a failed frame and returns a `failed`
 * outcome so callers can propagate the error without duplicating the
 * try-catch pattern.
 * @param conditionExpr - Expression string to evaluate.
 * @param conditionKind - `'when'` or `'skip'` (used in error messages).
 * @param child - Child node whose condition is being evaluated.
 * @param ctx - Runtime context for frame creation.
 * @param localCtx - Current expression evaluation context.
 * @param parentPath - Frame path for the created frame on failure.
 * @param parentFrameId - Parent frame ID for the created frame on failure.
 * @returns `{ result: boolean }` on success, or a failed {@link NodeOutcome} on error.
 */
async function evaluateConditionExpression(
  conditionExpr: string,
  conditionKind: 'when' | 'skip',
  child: WorkflowSequenceNode['nodes'][number],
  ctx: RuntimeContext,
  localCtx: PrimitiveExpressionContext,
  parentPath: string[],
  parentFrameId: string | undefined,
): Promise<{ result: boolean } | NodeOutcome> {
  try {
    return { result: evaluateNodeCondition(conditionExpr, localCtx) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const frame = ctx.createFrame({ nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
    await failFrame(frame, ctx, `'${conditionKind}' condition evaluation failed: ${message}`);
    return { status: 'failed', error: `'${conditionKind}' condition evaluation failed for '${child.id}': ${message}` };
  }
}

/**
 * Execute a single child node within a sequence.
 *
 * Handles frame creation, abort checks, execution dispatch, and outcome
 * application. Returns `null` to indicate the caller should `continue` to the
 * next child (skipped outcome), or a terminal {@link NodeOutcome} when the
 * sequence must stop.
 * @param child - The child node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param localCtx - Current expression evaluation context.
 * @param parentPath - Accumulated frame-ID path from root to parent (exclusive).
 * @param parentFrameId - Frame ID of the enclosing container node (if any).
 * @returns Updated localCtx and optional terminal outcome.
 */
async function executeSequenceChild(
  child: WorkflowSequenceNode['nodes'][number],
  ctx: RuntimeContext,
  localCtx: PrimitiveExpressionContext,
  parentPath: string[],
  parentFrameId: string | undefined,
): Promise<{ updatedCtx: PrimitiveExpressionContext; outcome?: NodeOutcome; skip?: boolean }> {
  const frame = ctx.createFrame({ nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
  if (ctx.signal.aborted) {
    await cancelFrame(frame, ctx);
    return { updatedCtx: localCtx, outcome: { status: 'cancelled' } };
  }
  await startFrame(frame, ctx);
  let outcome: NodeOutcome;
  try {
    outcome = await executeNode(child, ctx, localCtx, executeSequence, frame.frameId, frame.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failFrame(frame, ctx, message);
    return { updatedCtx: localCtx, outcome: { status: 'failed', error: message } };
  }
  switch (outcome.status) {
    case 'completed': {
      await completeFrame(frame, ctx, outcome.output);
      return {
        updatedCtx: mergeFrameOutput(localCtx, child.id, { status: 'completed', output: outcome.output }),
      };
    }
    case 'skipped': {
      await skipFrame(frame, ctx);
      return { updatedCtx: mergeFrameOutput(localCtx, child.id, { status: 'skipped' }) };
    }
    case 'cancelled': {
      await cancelFrame(frame, ctx);
      return { updatedCtx: localCtx, outcome: { status: 'cancelled' } };
    }
    case 'failed': {
      await failFrame(frame, ctx, outcome.error);
      return { updatedCtx: localCtx, outcome: { status: 'failed', error: outcome.error } };
    }
  }
}

/**
 * Execute a `sequence` node by walking its children in declaration order.
 *
 * Each child node is executed sequentially:
 * 1. Check the abort signal — remaining children are cancelled on abort.
 * 2. Evaluate `when` — if falsy, skip the node (and its subtree) without failing.
 * 3. Evaluate `skip` — if truthy, skip the node (and its subtree) without failing.
 * 4. Create a frame for the child.
 * 5. Start the frame (emit `frame.started`).
 * 6. Execute the child via the dispatcher.
 * 7. Apply the outcome to the frame and update the expression context.
 * 8. If the child failed, immediately propagate failure up to the caller.
 *
 * The sequence itself does not create a frame; only leaf and container nodes
 * within the sequence have frames. The `parentFrameId` and `parentPath`
 * parameters propagate the caller's frame identity into child frame paths.
 *
 * After each completed child the expression context is updated with the
 * child's output so downstream `when`/`skip` conditions can reference it.
 * @param node - The sequence node whose children will be executed.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param parentFrameId - Frame ID of the enclosing container node (if any).
 * @param parentPath - Accumulated frame-ID path from root to parent (exclusive).
 * @returns Terminal outcome for the sequence as a whole.
 */
export async function executeSequence(
  node: WorkflowSequenceNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  parentFrameId?: string,
  parentPath: string[] = [],
): Promise<NodeOutcome> {
  let localCtx: PrimitiveExpressionContext = expressionCtx;

  for (const child of node.nodes) {
    if (ctx.signal.aborted) {
      return { status: 'cancelled' };
    }

    if (child.when !== undefined) {
      const condResult = await evaluateConditionExpression(
        child.when,
        'when',
        child,
        ctx,
        localCtx,
        parentPath,
        parentFrameId,
      );
      if ('status' in condResult) return condResult;
      if (!condResult.result) {
        const frame = ctx.createFrame({ nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
        await skipFrame(frame, ctx);
        localCtx = mergeFrameOutput(localCtx, child.id, { status: 'skipped' });
        continue;
      }
    }

    if (child.skip !== undefined) {
      const condResult = await evaluateConditionExpression(
        child.skip,
        'skip',
        child,
        ctx,
        localCtx,
        parentPath,
        parentFrameId,
      );
      if ('status' in condResult) return condResult;
      if (condResult.result) {
        const frame = ctx.createFrame({ nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
        await skipFrame(frame, ctx);
        localCtx = mergeFrameOutput(localCtx, child.id, { status: 'skipped' });
        continue;
      }
    }

    const { updatedCtx, outcome } = await executeSequenceChild(child, ctx, localCtx, parentPath, parentFrameId);
    localCtx = updatedCtx;
    if (outcome !== undefined) {
      return outcome;
    }
  }

  return { status: 'completed' };
}

// ─────────────────────────────────────────────────────────────
// Context mutation helper
// ─────────────────────────────────────────────────────────────

/**
 * Produce an updated expression context with a completed child's output
 * merged into the `frames` map and derived expression aliases.
 *
 * Returns a new context object rather than mutating the existing one so
 * callers can safely hold references to the original context.
 * @param ctx - Current expression context.
 * @param nodeId - Node ID of the child that completed.
 * @param entry - Frame entry to merge (`status` and optional `output`).
 * @returns Updated expression context.
 */
function mergeFrameOutput(
  ctx: PrimitiveExpressionContext,
  nodeId: string,
  entry: { status: 'completed' | 'skipped'; output?: JsonValue } | { status: 'skipped' },
): PrimitiveExpressionContext {
  const frames = {
    ...ctx.frames,
    [nodeId]: entry,
  };
  return {
    ...ctx,
    frames,
    previousSteps: buildPreviousStepsFromFrames(frames),
    output: entry.status === 'completed' ? entry.output : ctx.output,
  };
}
