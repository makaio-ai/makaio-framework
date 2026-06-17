import { evaluateSync } from '@makaio/expression';
import type {
  JsonValue,
  WorkflowDelegateAgentNode,
  WorkflowDelegateRoleNode,
  WorkflowFrameState,
  WorkflowGateNode,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
  WorkflowStationNode,
} from '@makaio/contracts';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import { executeStationNode } from './station-node.js';
import { executeDelegateAgentNode, executeDelegateRoleNode } from './delegate-node.js';
import { executeParallelNode } from './parallel-node.js';
import { executeGateNode } from './gate-node.js';
import { executeIterateNode } from './iterate-node.js';
import { executeIterateChainNode } from './iterate-chain-node.js';
import { executeLoopNode } from './loop-node.js';

// ─────────────────────────────────────────────────────────────
// Node execution result
// ─────────────────────────────────────────────────────────────

/**
 * Terminal outcome of executing a single workflow node.
 *
 * Discriminated on `status` so callers can pattern-match without
 * narrowing through `instanceof` checks.
 *
 * The `paused` status is produced when a gate node parks execution for an
 * `exit-and-redispatch` or `exit-and-resume` suspension strategy. The runner
 * should persist state and exit; the workflow will be re-dispatched when the
 * gate is resolved externally.
 */
export type NodeOutcome =
  | { status: 'completed'; output?: JsonValue }
  | { status: 'skipped' }
  | { status: 'cancelled' }
  | { status: 'paused'; pausedAtGateId: string; pausedAtFrameId: string }
  | { status: 'failed'; error: string };

// ─────────────────────────────────────────────────────────────
// Frame lifecycle helpers
// ─────────────────────────────────────────────────────────────

/**
 * Transition a frame from `pending` to `running`, persist the started
 * timestamp, and emit the `frame.started` bus event.
 *
 * Must be called after the abort-signal check and condition evaluation
 * so that frames are only emitted for nodes that actually execute.
 * @param frame - The frame to start (mutated in place).
 * @param ctx - Runtime context used for event emission.
 */
export async function startFrame(frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'running';
  frame.startedAt = Date.now();
  await ctx.persistFrame(frame);
  await ctx.emitFrameStarted(frame);
}

/**
 * Transition a frame to `completed`, persist the output and timestamps,
 * and emit the `frame.completed` bus event.
 * @param frame - The frame to complete (mutated in place).
 * @param ctx - Runtime context used for event emission.
 * @param output - JSON-serializable output produced by the node.
 */
export async function completeFrame(frame: WorkflowFrameState, ctx: RuntimeContext, output?: JsonValue): Promise<void> {
  const completedAt = Date.now();
  const durationMs = frame.startedAt !== undefined ? Math.max(0, completedAt - frame.startedAt) : undefined;
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'completed';
  frame.output = output;
  frame.completedAt = completedAt;
  await ctx.persistFrame(frame);
  await ctx.emitFrameCompleted(frame, durationMs);
}

/**
 * Transition a frame to `failed`, persist the error and timestamps,
 * and emit the `frame.failed` bus event.
 * @param frame - The frame to fail (mutated in place).
 * @param ctx - Runtime context used for event emission.
 * @param error - Human-readable failure reason.
 */
export async function failFrame(frame: WorkflowFrameState, ctx: RuntimeContext, error: string): Promise<void> {
  const completedAt = Date.now();
  const durationMs = frame.startedAt !== undefined ? Math.max(0, completedAt - frame.startedAt) : undefined;
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'failed';
  frame.error = error;
  frame.completedAt = completedAt;
  await ctx.persistFrame(frame);
  await ctx.emitFrameFailed(frame, error, durationMs);
}

/**
 * Transition a frame to `skipped` and persist the status.
 *
 * Skipped frames do not emit `frame.started` because the node never ran.
 * No bus event is emitted — the status is visible only via the frame registry.
 * @param frame - The frame to skip (mutated in place).
 * @param ctx - Runtime context used for frame persistence.
 */
export async function skipFrame(frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'skipped';
  frame.completedAt = Date.now();
  await ctx.persistFrame(frame);
}

/**
 * Transition a frame to `cancelled` and persist the status.
 *
 * Cancelled frames do not emit `frame.started` because the node never ran.
 * No bus event is emitted — the status is visible only via the frame registry.
 * @param frame - The frame to cancel (mutated in place).
 * @param ctx - Runtime context used for frame persistence.
 */
export async function cancelFrame(frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'cancelled';
  frame.completedAt = Date.now();
  await ctx.persistFrame(frame);
}

// ─────────────────────────────────────────────────────────────
// Condition evaluation
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a jexl expression against the primitive expression context.
 *
 * Returns the truthy/falsy result directly so callers can decide whether to
 * skip or execute the node. Throws propagate as frame failures.
 * @param expression - jexl expression string.
 * @param expressionCtx - Evaluation context.
 * @returns Boolean result of evaluating the expression.
 */
export function evaluateNodeCondition(expression: string, expressionCtx: PrimitiveExpressionContext): boolean {
  return Boolean(evaluateSync(expression, buildRuntimeExpressionScope(expressionCtx)));
}

// ─────────────────────────────────────────────────────────────
// Sequence executor type (injected to break circular dep)
// ─────────────────────────────────────────────────────────────

/**
 * Function signature for the sequence executor, injected into
 * {@link executeNode} by `primitive-runtime.ts` to break the circular
 * import dependency.
 *
 * `primitive-runtime.ts` imports `executeNode` and passes itself as the
 * `executeSequenceFn` argument, so there is no circular module-level
 * dependency.
 */
export type ExecuteSequenceFn = (
  node: WorkflowSequenceNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  parentFrameId?: string,
  parentPath?: string[],
) => Promise<NodeOutcome>;

// ─────────────────────────────────────────────────────────────
// Central node dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Dispatch a workflow node to its type-specific executor.
 *
 * This is the central dispatch table for the primitive runtime. All node
 * types are implemented: `sequence`, `station`, `delegate-agent`,
 * `delegate-role`, `parallel`, `gate`, `iterate`, `iterate-chain`, and `loop`.
 *
 * The `executeSequenceFn` parameter is injected by `primitive-runtime.ts` to
 * avoid a circular module-level import between this file and
 * `primitive-runtime.ts`. Both files depend on each other at the function
 * level; injecting the dependency at the call-site breaks the cycle cleanly.
 * @param node - The workflow node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param executeSequenceFn - Injected sequence executor (from primitive-runtime.ts).
 * @param currentFrameId - Frame ID for the node currently being dispatched. Leaf
 *   executors use it for their own frame-linked events; container executors pass
 *   it to child frames as their parent frame ID.
 * @param parentPath - Frame-ID path of ancestor frames (without this node's frame ID).
 * @returns Terminal execution outcome for this node.
 */
export async function executeNode(
  node: WorkflowNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  currentFrameId?: string,
  parentPath: string[] = [],
): Promise<NodeOutcome> {
  // Abort check before creating any frame so cancelled nodes produce no
  // frame events (preserving the invariant that frames only exist for nodes
  // that the runtime actually attempted to execute or skip).
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  switch (node.type) {
    case 'sequence':
      return executeSequenceFn(node as WorkflowSequenceNode, ctx, expressionCtx, currentFrameId, parentPath);

    case 'station':
      return executeStationNode(node as WorkflowStationNode, ctx, expressionCtx, currentFrameId);

    case 'delegate-agent':
      return executeDelegateAgentNode(node as WorkflowDelegateAgentNode, ctx, expressionCtx, currentFrameId);

    case 'delegate-role':
      return executeDelegateRoleNode(node as WorkflowDelegateRoleNode, ctx, expressionCtx, currentFrameId);

    case 'parallel':
      // The parallel node's own frame is created by the sequence loop in
      // primitive-runtime.ts before executeNode is called. The current frame
      // ID and path are forwarded as parentFrameId/parentPath for branch frames.
      return executeParallelNode(
        node as WorkflowParallelNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
        (node as WorkflowParallelNode).mode ?? 'all-settled',
      );

    case 'gate':
      // The gate's own frame is created by the sequence loop in
      // primitive-runtime.ts before executeNode is called. The current frame
      // ID is forwarded so the gate executor can update frame
      // state while suspended.
      return executeGateNode(node as WorkflowGateNode, ctx, expressionCtx, currentFrameId ?? '');

    case 'iterate':
      return executeIterateNode(
        node as WorkflowIterateNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
      );

    case 'iterate-chain':
      return executeIterateChainNode(
        node as WorkflowIterateChainNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
      );

    case 'loop':
      return executeLoopNode(
        node as WorkflowLoopNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
      );

    default: {
      // Unreachable if WorkflowNodeType covers all cases. This guard ensures
      // new node types added to the enum surface a compile-time error here
      // rather than silently falling through.
      return {
        status: 'failed',
        error: `Unknown node type: ${String((node as WorkflowNode).type)}`,
      };
    }
  }
}
