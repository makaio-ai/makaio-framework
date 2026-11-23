import type { CallContext } from '@makaio/core';
import { evaluateSync } from '@makaio/expression';
import {
  LoopCheckOutcomeSchema,
  type JsonValue,
  type LoopCheckHandler,
  type LoopCheckOutcome,
  type WorkflowFrameState,
  type WorkflowLoopNode,
} from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import { cancelFrame, completeFrame, failFrame, failFrameFromException, startFrame } from './node-execution.js';
import {
  buildRuntimeExpressionScope,
  mergeFrameOutput,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import { extractLastSequenceOutput } from './iterate-helpers.js';

// -----------------------------------------------------------------
// Loop output type
// -----------------------------------------------------------------

/** Output produced by a completed `loop` node. */
export interface LoopOutput {
  /** Whether a check passed before or on the final round. */
  readonly passed: boolean;
  /** Total number of rounds executed (1-based). */
  readonly rounds: number;
  /** Ordered body outputs from each round. */
  readonly bodyOutputs: readonly JsonValue[];
}

/**
 * Build the same output shape for convergence and completion on exhaustion.
 * @param passed - Whether a check passed.
 * @param bodyOutputs - Ordered output of all completed rounds.
 * @returns The completed loop outcome.
 */
function completeLoop(passed: boolean, bodyOutputs: JsonValue[]): NodeOutcome {
  const output: LoopOutput = { passed, rounds: bodyOutputs.length, bodyOutputs };
  return { status: 'completed', output };
}

// -----------------------------------------------------------------
// Per-round body execution
// -----------------------------------------------------------------

/**
 * Result of executing one loop round's body sequence.
 *
 * Discriminated on `terminal`: when `true` the enclosing loop must
 * return the contained {@link NodeOutcome} immediately. When `false`
 * the body completed successfully and `output` carries the JSON-safe
 * per-round body output. Rounds without output use `null` because
 * {@link LoopOutput.bodyOutputs} is an ordered JSON array.
 */
type RoundBodyResult =
  | { terminal: true; outcome: NodeOutcome }
  | {
      terminal: false;
      output: JsonValue;
      checkExpressionCtx: PrimitiveExpressionContext;
    };

/**
 * Execute the body sequence for a single loop round.
 *
 * Creates a per-round iteration frame, runs the body sequence, and returns
 * its output or propagates failure or cancellation.
 * @param call - Call context of the message that drives this execution run.
 * @param node - The loop node (provides body sequence and node ID).
 * @param round - Zero-based round index for the iteration frame.
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression evaluation context for body nodes.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Loop container frame ID.
 * @param parentPath - Loop container frame path.
 * @returns Body result indicating success with output or a terminal outcome.
 */
async function executeRoundBody(
  call: CallContext,
  node: WorkflowLoopNode,
  round: number,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<RoundBodyResult> {
  const frame = ctx.createFrame(call, {
    nodeId: node.id,
    nodeType: 'loop',
    path: parentPath,
    parentFrameId,
    iteration: round,
  });

  if (ctx.signal.aborted) {
    await cancelFrame(call, frame, ctx);
    return { terminal: true, outcome: { status: 'cancelled' } };
  }

  await startFrame(call, frame, ctx);

  const bodyOutcome = await runBodySequence(call, node, frame, ctx, expressionCtx, executeSequenceFn);
  if (bodyOutcome !== undefined) {
    return { terminal: true, outcome: bodyOutcome };
  }

  const bodyOutput = extractLastSequenceOutput(node.body, frame.frameId, ctx) ?? null;
  await completeFrame(call, frame, ctx, bodyOutput);
  return {
    terminal: false,
    output: bodyOutput,
    checkExpressionCtx: buildLoopCheckExpressionContext(node, ctx, expressionCtx, frame.frameId),
  };
}

/**
 * Build the expression context visible to the loop check after a body round.
 *
 * `executeSequence` keeps body-local frame outputs in its local context, so the
 * loop reconstructs the same public frame view from the runtime frame registry.
 * @param node - Loop node whose body frame outputs should be exposed.
 * @param ctx - Runtime context containing completed body frames.
 * @param baseCtx - Outer expression context inherited by the loop.
 * @param roundFrameId - Frame ID of this loop round.
 * @returns Expression context that includes body node frame outputs.
 */
function buildLoopCheckExpressionContext(
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  baseCtx: PrimitiveExpressionContext,
  roundFrameId: string,
): PrimitiveExpressionContext {
  let checkCtx = baseCtx;
  for (const bodyNode of node.body.nodes) {
    const frame = ctx
      .getFramesByNodeId(bodyNode.id)
      .find((candidate) => candidate.parentFrameId === roundFrameId && candidate.status === 'completed');
    if (frame !== undefined) {
      checkCtx = mergeFrameOutput(checkCtx, bodyNode.id, {
        status: 'completed',
        ...(frame.output !== undefined ? { output: frame.output } : {}),
      });
    }
  }
  return checkCtx;
}

/**
 * Run the body sequence inside a started frame.
 *
 * Returns `undefined` when the body completed or was skipped (caller
 * should extract body output), or a terminal {@link NodeOutcome} that
 * the loop must propagate immediately.
 * @param call - Call context of the message that drives this execution run.
 * @param node - Loop node providing the body sequence.
 * @param frame - Started iteration frame.
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression context for the body.
 * @param executeSequenceFn - Injected sequence executor.
 * @returns Terminal outcome to propagate, or `undefined` on success.
 */
async function runBodySequence(
  call: CallContext,
  node: WorkflowLoopNode,
  frame: WorkflowFrameState,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
): Promise<NodeOutcome | undefined> {
  let bodyOutcome: NodeOutcome;
  try {
    bodyOutcome = await executeSequenceFn(call, node.body, ctx, expressionCtx, frame.frameId, frame.path);
  } catch (error) {
    const message = await failFrameFromException(call, frame, ctx, error);
    return { status: 'failed', error: message };
  }

  switch (bodyOutcome.status) {
    case 'failed': {
      await failFrame(call, frame, ctx, bodyOutcome.error);
      return { status: 'failed', error: bodyOutcome.error };
    }
    case 'cancelled': {
      await cancelFrame(call, frame, ctx);
      return { status: 'cancelled' };
    }
    case 'skipped':
    case 'completed': {
      return undefined;
    }
  }
}

// -----------------------------------------------------------------
// Check evaluation
// -----------------------------------------------------------------

/**
 * Resolve the check input and invoke the handler after a completed round.
 * @param node - Loop node providing check configuration.
 * @param round - Zero-based round index (converted to 1-based for the handler).
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression context for check input evaluation.
 * @param checkHandler - Resolved check handler function.
 * @returns Check outcome or a terminal failure outcome.
 */
function evaluateCheck(
  node: WorkflowLoopNode,
  round: number,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  checkHandler: LoopCheckHandler,
): LoopCheckOutcome | Extract<NodeOutcome, { status: 'failed' }> {
  let checkInput: JsonValue = null;
  if (node.check.input !== undefined) {
    try {
      const scope = buildRuntimeExpressionScope(expressionCtx);
      checkInput = evaluateSync(node.check.input, scope) as JsonValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        error: `Loop node '${node.id}': check input expression evaluation failed: ${message}`,
      };
    }
  }

  try {
    const outcome = checkHandler(checkInput, node.check.config ?? null, {
      executionId: ctx.executionId,
      nodeId: node.id,
      round: round + 1,
      maxRounds: node.maxRounds,
    });
    const parsed = LoopCheckOutcomeSchema.safeParse(outcome);
    if (parsed.success) return parsed.data;
    return {
      status: 'failed',
      error: `Loop node '${node.id}': check handler '${node.check.handler}' returned an invalid outcome: ${parsed.error.message}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: `Loop node '${node.id}': check handler '${node.check.handler}' threw: ${message}`,
    };
  }
}

// -----------------------------------------------------------------
// Loop node executor
// -----------------------------------------------------------------

/**
 * Execute a `loop` node until a check passes or the round limit is reached.
 *
 * Each round runs the body in a fresh iteration frame before evaluating the
 * check. Reaching `maxRounds` without a passing check follows `onExhausted`.
 * @param call - Call context of the message that drives this execution run.
 * @param node - The loop node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the loop container frame.
 * @param parentPath - Frame-ID path including the container.
 * @returns Terminal execution outcome for the loop node.
 */
export async function executeLoopNode(
  call: CallContext,
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) return { status: 'cancelled' };

  const checkHandler = ctx.runtimeLoopChecks.get(node.check.handler);
  if (checkHandler === undefined) {
    return {
      status: 'failed',
      error: `Loop node '${node.id}': no check handler registered for '${node.check.handler}'`,
    };
  }

  const bodyOutputs: JsonValue[] = [];
  for (let round = 0; round < node.maxRounds; round++) {
    if (ctx.signal.aborted) return { status: 'cancelled' };

    const bodyResult = await executeRoundBody(
      call,
      node,
      round,
      ctx,
      expressionCtx,
      executeSequenceFn,
      parentFrameId,
      parentPath,
    );
    if (bodyResult.terminal) return bodyResult.outcome;
    bodyOutputs.push(bodyResult.output);

    const checkResult = evaluateCheck(node, round, ctx, bodyResult.checkExpressionCtx, checkHandler);
    if ('status' in checkResult) return checkResult;
    if (checkResult.kind === 'pass') return completeLoop(true, bodyOutputs);
  }
  if (node.onExhausted === 'complete') return completeLoop(false, bodyOutputs);
  return {
    status: 'failed',
    error: `Loop node '${node.id}' exhausted maxRounds (${node.maxRounds}) without a passing check`,
  };
}
