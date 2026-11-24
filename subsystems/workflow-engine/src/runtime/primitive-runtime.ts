import type { CallContext } from '@makaio/core';
import type { WorkflowSequenceNode } from '@makaio/contracts';
import { mergeFrameOutput, type PrimitiveExpressionContext, type RuntimeContext } from './runtime-context.js';
import {
  cancelFrame,
  completeFrame,
  evaluateNodeCondition,
  executeNode,
  failFrame,
  failFrameFromException,
  skipFrame,
  startFrame,
  type NodeOutcome,
} from './node-execution.js';

/**
 * Create and persist a `skipped` frame for a sequence child whose `when` or `skip` condition excluded it.
 * @param call - Call context of the message that drives this execution run.
 * @param ctx - Execution-wide runtime context.
 * @param child - Sequence child that is skipped.
 * @param parentPath - Frame path for the created frame.
 * @param parentFrameId - Parent frame ID for the created frame.
 */
async function skipChildFrame(
  call: CallContext,
  ctx: RuntimeContext,
  child: WorkflowSequenceNode['nodes'][number],
  parentPath: string[],
  parentFrameId: string | undefined,
): Promise<void> {
  const frame = ctx.createFrame(call, { nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
  await skipFrame(call, frame, ctx);
}

// ─────────────────────────────────────────────────────────────
// Sequence execution
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a `when` or `skip` condition expression and return the result.
 *
 * On evaluation failure, creates a failed frame and returns a `failed`
 * outcome so callers can propagate the error without duplicating the
 * try-catch pattern.
 * @param call - Call context of the message that drives this execution run.
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
  call: CallContext,
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
    const frame = ctx.createFrame(call, {
      nodeId: child.id,
      nodeType: child.type,
      path: parentPath,
      parentFrameId,
    });
    await failFrame(call, frame, ctx, `'${conditionKind}' condition evaluation failed: ${message}`);
    return { status: 'failed', error: `'${conditionKind}' condition evaluation failed for '${child.id}': ${message}` };
  }
}

/**
 * Execute a single child node within a sequence.
 *
 * Creates the child frame, checks cancellation, and applies the dispatched outcome.
 * @param call - Call context of the message that drives this execution run.
 * @param child - The child node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param localCtx - Current expression evaluation context.
 * @param parentPath - Accumulated frame-ID path from root to parent (exclusive).
 * @param parentFrameId - Frame ID of the enclosing container node (if any).
 * @returns Updated expression context and an outcome if the sequence must stop.
 */
async function executeSequenceChild(
  call: CallContext,
  child: WorkflowSequenceNode['nodes'][number],
  ctx: RuntimeContext,
  localCtx: PrimitiveExpressionContext,
  parentPath: string[],
  parentFrameId: string | undefined,
): Promise<{ updatedCtx: PrimitiveExpressionContext; outcome?: NodeOutcome }> {
  const frame = ctx.createFrame(call, { nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
  if (ctx.signal.aborted) {
    await cancelFrame(call, frame, ctx);
    return { updatedCtx: localCtx, outcome: { status: 'cancelled' } };
  }
  await startFrame(call, frame, ctx);
  let outcome: NodeOutcome;
  try {
    outcome = await executeNode(call, child, ctx, localCtx, executeSequence, frame.frameId, frame.path);
  } catch (error) {
    const message = await failFrameFromException(call, frame, ctx, error);
    return { updatedCtx: localCtx, outcome: { status: 'failed', error: message } };
  }
  switch (outcome.status) {
    case 'completed': {
      await completeFrame(call, frame, ctx, outcome.output);
      return {
        updatedCtx: mergeFrameOutput(localCtx, child.id, { status: 'completed', output: outcome.output }),
      };
    }
    case 'skipped': {
      await skipFrame(call, frame, ctx);
      return { updatedCtx: mergeFrameOutput(localCtx, child.id, { status: 'skipped' }) };
    }
    case 'cancelled': {
      await cancelFrame(call, frame, ctx);
      return { updatedCtx: localCtx, outcome: { status: 'cancelled' } };
    }
    case 'failed': {
      await failFrame(call, frame, ctx, outcome.error, outcome.detail);
      return { updatedCtx: localCtx, outcome: { status: 'failed', error: outcome.error } };
    }
  }
}

/**
 * Execute a `sequence` node by walking its children in declaration order.
 *
 * Each child node is executed sequentially:
 * 1. Check the abort signal before evaluating the next child.
 * 2. Evaluate `when` and `skip` to decide whether to skip the child and its subtree.
 * 3. Create and start the frame for a child that will execute.
 * 4. Dispatch the child, apply its outcome, and update the expression context.
 * 5. Propagate cancellation or failure to the caller and stop the sequence.
 *
 * The sequence itself does not create a frame; only leaf and container nodes
 * within the sequence have frames. The `parentFrameId` and `parentPath`
 * parameters propagate the caller's frame identity into child frame paths.
 *
 * After each completed child the expression context is updated with the
 * child's output so downstream `when`/`skip` conditions can reference it.
 * @param call - Call context of the message that drives this execution run.
 * @param node - The sequence node whose children will be executed.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param parentFrameId - Frame ID of the enclosing container node (if any).
 * @param parentPath - Accumulated frame-ID path from root to parent (exclusive).
 * @returns Terminal outcome for the sequence as a whole.
 */
export async function executeSequence(
  call: CallContext,
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
        call,
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
        await skipChildFrame(call, ctx, child, parentPath, parentFrameId);
        localCtx = mergeFrameOutput(localCtx, child.id, { status: 'skipped' });
        continue;
      }
    }

    if (child.skip !== undefined) {
      const condResult = await evaluateConditionExpression(
        call,
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
        await skipChildFrame(call, ctx, child, parentPath, parentFrameId);
        localCtx = mergeFrameOutput(localCtx, child.id, { status: 'skipped' });
        continue;
      }
    }

    const { updatedCtx, outcome } = await executeSequenceChild(call, child, ctx, localCtx, parentPath, parentFrameId);
    localCtx = updatedCtx;
    if (outcome !== undefined) {
      return outcome;
    }
  }

  return { status: 'completed' };
}
