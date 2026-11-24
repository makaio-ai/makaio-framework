import type { CallContext } from '@makaio/core';
import { LoopCheckOutputSchema, type JsonValue, type WorkflowLoopNode } from '@makaio/contracts';
import {
  cancelFrame,
  completeFrame,
  failFrame,
  failFrameFromException,
  startFrame,
  type ExecuteSequenceFn,
  type NodeOutcome,
} from './node-execution.js';
import type { PrimitiveExpressionContext, RuntimeContext } from './runtime-context.js';
import { extractLastSequenceOutput } from './iterate-helpers.js';

/** A round either yields a checked body result or ends the entire loop. */
type LoopRound =
  | { status: 'checked'; output: JsonValue; done: boolean }
  | Extract<NodeOutcome, { status: 'failed' | 'cancelled' }>;

/**
 * Run the body using the normal step dispatcher and read its one convergence result.
 * @param call - Call context driving the workflow.
 * @param node - Loop definition and its convergence step reference.
 * @param round - Zero-based round index.
 * @param ctx - Workflow runtime context.
 * @param expressionCtx - Outer expression context for the body.
 * @param executeSequenceFn - Normal sequence executor.
 * @param parentFrameId - Frame of the loop node itself.
 * @param parentPath - Frame path inherited from the loop node.
 * @returns The round result or a failure or cancellation to propagate.
 */
async function executeLoopRound(
  call: CallContext,
  node: WorkflowLoopNode,
  round: number,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string | undefined,
  parentPath: string[],
): Promise<LoopRound> {
  const frame = ctx.createFrame(call, {
    nodeId: node.id,
    nodeType: node.type,
    path: parentPath,
    parentFrameId,
    iteration: round,
  });
  await startFrame(call, frame, ctx);
  let outcome: NodeOutcome;
  try {
    outcome = await executeSequenceFn(call, node.body, ctx, expressionCtx, frame.frameId, frame.path);
  } catch (error) {
    return { status: 'failed', error: await failFrameFromException(call, frame, ctx, error) };
  }

  if (outcome.status === 'failed') {
    await failFrame(call, frame, ctx, outcome.error, outcome.detail);
    return outcome;
  }
  if (outcome.status === 'cancelled' || ctx.signal.aborted) {
    await cancelFrame(call, frame, ctx);
    return { status: 'cancelled' };
  }

  // A step can occur under a nested container and across several rounds. Scope
  // its frame to this round, and reject zero or multiple convergence results.
  const [check, extra] = ctx
    .getFramesByNodeId(node.check)
    .filter((candidate) => candidate.path.includes(frame.frameId));
  const parsed = LoopCheckOutputSchema.safeParse(check?.status === 'completed' ? check.output : undefined);
  if (extra !== undefined || !parsed.success) {
    const unexpectedKeys = parsed.error?.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' ? issue.keys.map((key) => JSON.stringify(key)) : [],
    );
    const fields = unexpectedKeys?.length ? `. Unexpected fields ${unexpectedKeys.join(', ')}` : '';
    const error = `Loop '${node.id}' requires one completed '${node.check}' step with a boolean done result per round${fields}`;
    await failFrame(call, frame, ctx, error);
    return { status: 'failed', error };
  }

  const output = extractLastSequenceOutput(node.body, frame.frameId, ctx) ?? null;
  await completeFrame(call, frame, ctx, output);
  return { status: 'checked', output, done: parsed.data.done };
}

/**
 * Repeat a loop body until the referenced step converges or the round limit is reached.
 * @param call - Call context driving the workflow.
 * @param node - Loop definition and its exhaustion policy.
 * @param ctx - Workflow runtime context.
 * @param expressionCtx - Outer expression context for each round.
 * @param executeSequenceFn - Normal sequence executor.
 * @param parentFrameId - Frame of the loop node itself, when available.
 * @param parentPath - Frame path inherited from the loop node.
 * @returns The terminal result of the loop.
 */
export async function executeLoopNode(
  call: CallContext,
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string | undefined,
  parentPath: string[],
): Promise<NodeOutcome> {
  const bodyOutputs: JsonValue[] = [];
  for (let round = 0; round < node.maxRounds; round++) {
    if (ctx.signal.aborted) return { status: 'cancelled' };
    const result = await executeLoopRound(
      call,
      node,
      round,
      ctx,
      expressionCtx,
      executeSequenceFn,
      parentFrameId,
      parentPath,
    );
    if (result.status !== 'checked') return result;
    bodyOutputs.push(result.output);
    if (result.done) {
      return { status: 'completed', output: { passed: true, rounds: bodyOutputs.length, bodyOutputs } };
    }
  }
  if (node.onExhausted === 'complete') {
    return { status: 'completed', output: { passed: false, rounds: bodyOutputs.length, bodyOutputs } };
  }
  return {
    status: 'failed',
    error: `Loop node '${node.id}' exhausted maxRounds (${node.maxRounds}) without a passing check`,
  };
}
