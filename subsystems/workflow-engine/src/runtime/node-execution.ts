import type { CallContext } from '@makaio/core';
import { evaluateSync } from '@makaio/expression';
import type {
  JsonValue,
  WorkflowAgentStepNode,
  WorkflowCodeStepNode,
  WorkflowFrameState,
  WorkflowIterateChainNode,
  WorkflowIterateNode,
  WorkflowLoopNode,
  WorkflowNode,
  WorkflowParallelNode,
  WorkflowSequenceNode,
} from '@makaio/contracts';
import {
  buildRuntimeExpressionScope,
  FramePersistenceError,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import { executeCodeStepNode } from './code-step-node.js';
import { executeAgentStepNode } from './delegate-node.js';
import { executeParallelNode } from './parallel-node.js';
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
 */
export type NodeOutcome =
  | { status: 'completed'; output?: JsonValue }
  | { status: 'skipped' }
  | { status: 'cancelled' }
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
 * @param call - Call context of the message that drives this execution run.
 * @param frame - The frame to start (mutated in place).
 * @param ctx - Runtime context used for event emission.
 */
export async function startFrame(call: CallContext, frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'running';
  frame.startedAt = Date.now();
  await ctx.persistFrame(call, frame);
  await ctx.emitFrameStarted(call, frame);
}

/**
 * Transition a frame to `completed`, persist the output and timestamps,
 * and emit the `frame.completed` bus event.
 * @param call - Call context of the message that drives this execution run.
 * @param frame - The frame to complete (mutated in place).
 * @param ctx - Runtime context used for event emission.
 * @param output - JSON-serializable output produced by the node.
 */
export async function completeFrame(
  call: CallContext,
  frame: WorkflowFrameState,
  ctx: RuntimeContext,
  output?: JsonValue,
): Promise<void> {
  const completedAt = Date.now();
  const durationMs = frame.startedAt !== undefined ? Math.max(0, completedAt - frame.startedAt) : undefined;
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'completed';
  frame.output = output;
  frame.completedAt = completedAt;
  await ctx.persistFrame(call, frame);
  await ctx.emitFrameCompleted(call, frame, durationMs);
}

/**
 * Transition a frame to `failed`, persist the error and timestamps,
 * and emit the `frame.failed` bus event.
 * @param call - Call context of the message that drives this execution run.
 * @param frame - The frame to fail (mutated in place).
 * @param ctx - Runtime context used for event emission.
 * @param error - Human-readable failure reason.
 */
export async function failFrame(
  call: CallContext,
  frame: WorkflowFrameState,
  ctx: RuntimeContext,
  error: string,
): Promise<void> {
  const completedAt = Date.now();
  const durationMs = frame.startedAt !== undefined ? Math.max(0, completedAt - frame.startedAt) : undefined;
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'failed';
  frame.error = error;
  frame.completedAt = completedAt;
  await ctx.persistFrame(call, frame);
  await ctx.emitFrameFailed(call, frame, error, durationMs);
}

/**
 * Fail the current frame while preserving a child frame's technical failure.
 * @param call - Call context of the execution run.
 * @param frame - Enclosing frame being failed.
 * @param ctx - Context for storing and emitting the failed transition.
 * @param cause - Exception from the nested runtime.
 * @returns The message for a business-level failed outcome.
 */
export async function failFrameFromException(
  call: CallContext,
  frame: WorkflowFrameState,
  ctx: RuntimeContext,
  cause: unknown,
): Promise<string> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const checkpoint = failFrame(call, frame, ctx, message);
  if (cause instanceof FramePersistenceError) {
    await checkpoint.catch((error: unknown) => {
      console.warn(`[Runtime] Failed to record enclosing frame ${frame.frameId}:`, error);
    });
    throw cause;
  }
  await checkpoint;
  return message;
}

/**
 * Wait for all started runtime tasks before surfacing a technical failure.
 * @param tasks - In-flight branches or items in declaration order.
 * @returns Successful task results in declaration order.
 */
export async function drainRuntimeTasks<T>(tasks: Iterable<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  return settled.map((entry) => {
    if (entry.status === 'rejected') throw entry.reason;
    return entry.value;
  });
}

/**
 * Transition a frame to `skipped` and persist the status.
 *
 * Skipped frames do not emit `frame.started` because the node never ran.
 * No bus event is emitted — the status is visible only via the frame registry.
 * @param call - Call context of the message that drives this execution run.
 * @param frame - The frame to skip (mutated in place).
 * @param ctx - Runtime context used for frame persistence.
 */
export async function skipFrame(call: CallContext, frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'skipped';
  frame.completedAt = Date.now();
  await ctx.persistFrame(call, frame);
}

/**
 * Transition a frame to `cancelled` and persist the status.
 *
 * Cancelled frames do not emit `frame.started` because the node never ran.
 * No bus event is emitted — the status is visible only via the frame registry.
 * @param call - Call context of the message that drives this execution run.
 * @param frame - The frame to cancel (mutated in place).
 * @param ctx - Runtime context used for frame persistence.
 */
export async function cancelFrame(call: CallContext, frame: WorkflowFrameState, ctx: RuntimeContext): Promise<void> {
  // Direct mutations are sufficient — frame is the same reference stored in frameRegistry.
  frame.status = 'cancelled';
  frame.completedAt = Date.now();
  await ctx.persistFrame(call, frame);
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
  call: CallContext,
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
 * types are implemented: `sequence`, `code-step`, `agent-step`, `parallel`,
 * `iterate`, `iterate-chain`, and `loop`.
 *
 * The `executeSequenceFn` parameter is injected by `primitive-runtime.ts` to
 * avoid a circular module-level import between this file and
 * `primitive-runtime.ts`. Both files depend on each other at the function
 * level; injecting the dependency at the call-site breaks the cycle cleanly.
 * @param call - Call context of the message that drives this execution run.
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
  call: CallContext,
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
      return executeSequenceFn(call, node as WorkflowSequenceNode, ctx, expressionCtx, currentFrameId, parentPath);

    case 'code-step':
      return executeCodeStepNode(call, node as WorkflowCodeStepNode, ctx, expressionCtx, currentFrameId);

    case 'agent-step':
      return executeAgentStepNode(call, node as WorkflowAgentStepNode, ctx, expressionCtx, currentFrameId);

    case 'parallel':
      // The parallel node's own frame is created by the sequence loop in
      // primitive-runtime.ts before executeNode is called. The current frame
      // ID and path are forwarded as parentFrameId/parentPath for branch frames.
      return executeParallelNode(
        call,
        node as WorkflowParallelNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
        (node as WorkflowParallelNode).mode ?? 'all-settled',
      );

    case 'iterate':
      return executeIterateNode(
        call,
        node as WorkflowIterateNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
      );

    case 'iterate-chain':
      return executeIterateChainNode(
        call,
        node as WorkflowIterateChainNode,
        ctx,
        expressionCtx,
        executeSequenceFn,
        currentFrameId ?? '',
        parentPath,
      );

    case 'loop':
      return executeLoopNode(
        call,
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
