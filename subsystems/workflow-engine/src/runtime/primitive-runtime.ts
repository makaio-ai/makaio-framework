import type { WorkflowFrameState, WorkflowSequenceNode } from '@makaio/contracts';
import { type PrimitiveExpressionContext, type RuntimeContext } from './runtime-context.js';
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
import { findReusableResumeFrame, mergeFrameOutput } from './resume-frames.js';

/** Statuses that may be reused for structural containers during redispatch. */
const STRUCTURAL_RESUME_STATUSES = new Set<WorkflowFrameState['status']>([
  'completed',
  'skipped',
  'waiting',
  'running',
]);

/**
 * Whether a node owns structural child frames that must preserve parent frame identity during resume.
 * @param child - Sequence child node.
 * @returns True for structural container node types.
 */
function isStructuralResumeNode(child: WorkflowSequenceNode['nodes'][number]): boolean {
  return (
    child.type === 'parallel' || child.type === 'iterate' || child.type === 'iterate-chain' || child.type === 'loop'
  );
}

/**
 * Find a reusable frame for a sequence child, widening statuses only for structural containers.
 * @param ctx - Runtime context carrying the resume index.
 * @param child - Sequence child node.
 * @param parentFrameId - Parent frame ID for structural matching.
 * @returns Matching persisted frame, if one can be reused by the child.
 */
function findSequenceChildResumeFrame(
  ctx: RuntimeContext,
  child: WorkflowSequenceNode['nodes'][number],
  parentFrameId: string | undefined,
): WorkflowFrameState | undefined {
  return findReusableResumeFrame(ctx.resumeFrames, child.id, {
    parentFrameId,
    ...(isStructuralResumeNode(child) ? { statuses: STRUCTURAL_RESUME_STATUSES } : {}),
  });
}

/**
 * Merge a completed or skipped resume frame into the expression context.
 * @param localCtx - Current expression context.
 * @param child - Sequence child whose frame is being replayed.
 * @param resumeFrame - Persisted resume frame, if present.
 * @returns Updated expression context for terminal frames, otherwise `undefined`.
 */
function mergeTerminalResumeFrame(
  localCtx: PrimitiveExpressionContext,
  child: WorkflowSequenceNode['nodes'][number],
  resumeFrame: WorkflowFrameState | undefined,
): PrimitiveExpressionContext | undefined {
  if (resumeFrame?.status === 'completed') {
    return mergeFrameOutput(localCtx, child.id, {
      status: 'completed',
      ...(resumeFrame.output !== undefined ? { output: resumeFrame.output } : {}),
    });
  }
  if (resumeFrame?.status === 'skipped') {
    return mergeFrameOutput(localCtx, child.id, { status: 'skipped' });
  }
  return undefined;
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
 *
 * When `existingFrame` is provided (a `waiting` gate frame or nonterminal
 * structural frame being reused from a prior execution), the frame is not
 * re-started — the caller has already persisted it and its `status` reflects
 * the durable lifecycle state.
 * @param child - The child node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param localCtx - Current expression evaluation context.
 * @param parentPath - Accumulated frame-ID path from root to parent (exclusive).
 * @param parentFrameId - Frame ID of the enclosing container node (if any).
 * @param existingFrame - A pre-existing gate or structural frame to reuse instead of creating a new one.
 * @returns Updated localCtx and optional terminal outcome.
 */
async function executeSequenceChild(
  child: WorkflowSequenceNode['nodes'][number],
  ctx: RuntimeContext,
  localCtx: PrimitiveExpressionContext,
  parentPath: string[],
  parentFrameId: string | undefined,
  existingFrame?: WorkflowFrameState,
): Promise<{ updatedCtx: PrimitiveExpressionContext; outcome?: NodeOutcome; skip?: boolean }> {
  const frame =
    existingFrame ?? ctx.createFrame({ nodeId: child.id, nodeType: child.type, path: parentPath, parentFrameId });
  if (ctx.signal.aborted) {
    await cancelFrame(frame, ctx);
    return { updatedCtx: localCtx, outcome: { status: 'cancelled' } };
  }
  if (existingFrame === undefined) {
    await startFrame(frame, ctx);
  }
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
    case 'paused': {
      // The gate already persisted its frame as 'waiting'. Propagate the paused
      // outcome so the enclosing sequence exits cleanly without altering frame state.
      return { updatedCtx: localCtx, outcome };
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
 * 2. Resume fast-path — if a prior execution already produced a terminal frame
 *    for this node (`completed` or `skipped`), replay it into the local context
 *    and skip re-execution. A `waiting` gate frame is forwarded so the gate
 *    executor can read the already-resolved gate instance without re-suspending.
 * 3. Evaluate `when` — if falsy, skip the node (and its subtree) without failing.
 * 4. Evaluate `skip` — if truthy, skip the node (and its subtree) without failing.
 * 5. Create a frame for the child.
 * 6. Start the frame (emit `frame.started`).
 * 7. Execute the child via the dispatcher.
 * 8. Apply the outcome to the frame and update the expression context.
 * 9. If the child failed, immediately propagate failure up to the caller.
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

    // ── Resume-frame fast-path ─────────────────────────────────────────────
    // When a prior execution already produced a terminal result for this node,
    // replay it into the local context without re-executing the node.
    const resumeFrame = findSequenceChildResumeFrame(ctx, child, parentFrameId);
    const resumedCtx = mergeTerminalResumeFrame(localCtx, child, resumeFrame);
    if (resumedCtx !== undefined) {
      localCtx = resumedCtx;
      continue;
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

    // Reuse persisted waiting gate frames and nonterminal structural frames.
    // Loop escalation gates use the loop container as the gate frame and leave
    // it waiting, while descendant gates leave ancestor containers running.
    // Both states must preserve frame IDs for redispatch matching.
    const existingFrame =
      (resumeFrame?.status === 'waiting' && child.type === 'gate') ||
      ((resumeFrame?.status === 'running' || resumeFrame?.status === 'waiting') && isStructuralResumeNode(child))
        ? resumeFrame
        : undefined;
    const { updatedCtx, outcome } = await executeSequenceChild(
      child,
      ctx,
      localCtx,
      parentPath,
      parentFrameId,
      existingFrame,
    );
    localCtx = updatedCtx;
    if (outcome !== undefined) {
      return outcome;
    }
  }

  return { status: 'completed' };
}
