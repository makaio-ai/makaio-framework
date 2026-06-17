import { evaluateSync } from '@makaio/expression';
import type {
  JsonValue,
  LoopGateHandler,
  LoopGateOutcome,
  WorkflowFrameState,
  WorkflowLoopNode,
  WorkflowSequenceNode,
} from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import { cancelFrame, completeFrame, failFrame, startFrame } from './node-execution.js';
import {
  buildRuntimeExpressionScope,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import { extractLastSequenceOutput } from './iterate-helpers.js';
import { findReusableResumeFrame } from './resume-frames.js';
import { openEscalationGate, resolvePersistedEscalationGate } from './loop-escalation.js';

// -----------------------------------------------------------------
// Loop output type
// -----------------------------------------------------------------

/**
 * Output produced by a completed `loop` node.
 *
 * Contains the aggregate loop result including per-round body outputs
 * and the gate outcome that terminated the loop.
 */
export interface LoopOutput {
  /** Whether the loop exited via `pass` or `escalate`. */
  readonly outcome: 'pass' | 'escalate';
  /** Total number of rounds executed (1-based). */
  readonly rounds: number;
  /** The gate outcome that caused the loop to exit. */
  readonly lastGateOutcome: LoopGateOutcome;
  /** Ordered body outputs from each round. */
  readonly bodyOutputs: readonly JsonValue[];
  /**
   * Resume data from the escalation gate, when the loop was escalated
   * and the gate was resolved with user input. Absent for `pass` outcomes
   * and for escalation outcomes that complete without a gate.
   */
  readonly resumeData?: JsonValue;
}

// -----------------------------------------------------------------
// Per-round body execution
// -----------------------------------------------------------------

/**
 * Result of executing one loop round's body sequence.
 *
 * Discriminated on `terminal`: when `true` the enclosing loop must
 * return the contained {@link NodeOutcome} immediately. When `false`
 * the body completed successfully and `output` carries the extracted
 * body output.
 */
type RoundBodyResult = { terminal: true; outcome: NodeOutcome } | { terminal: false; output: JsonValue | undefined };

/**
 * Execute the body sequence for a single loop round.
 *
 * Creates a per-round iteration frame, runs the body sequence, and
 * either returns the extracted body output on success or a terminal
 * {@link NodeOutcome} on failure/cancellation/pause.
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
  node: WorkflowLoopNode,
  round: number,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<RoundBodyResult> {
  const frame = ctx.createFrame({
    nodeId: node.id,
    nodeType: 'loop',
    path: parentPath,
    parentFrameId,
    iteration: round,
  });

  if (ctx.signal.aborted) {
    await cancelFrame(frame, ctx);
    return { terminal: true, outcome: { status: 'cancelled' } };
  }

  await startFrame(frame, ctx);

  const bodyOutcome = await runBodySequence(node, frame, ctx, expressionCtx, executeSequenceFn);
  if (bodyOutcome !== undefined) {
    return { terminal: true, outcome: bodyOutcome };
  }

  const bodyOutput = extractLastSequenceOutput(node.body as WorkflowSequenceNode, frame.frameId, ctx);
  await completeFrame(frame, ctx, bodyOutput);
  return { terminal: false, output: bodyOutput };
}

/**
 * Run the body sequence inside a started frame.
 *
 * Returns `undefined` when the body completed or was skipped (caller
 * should extract body output), or a terminal {@link NodeOutcome} that
 * the loop must propagate immediately.
 * @param node - Loop node providing the body sequence.
 * @param frame - Started iteration frame.
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression context for the body.
 * @param executeSequenceFn - Injected sequence executor.
 * @returns Terminal outcome to propagate, or `undefined` on success.
 */
async function runBodySequence(
  node: WorkflowLoopNode,
  frame: WorkflowFrameState,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
): Promise<NodeOutcome | undefined> {
  let bodyOutcome: NodeOutcome;
  try {
    bodyOutcome = await executeSequenceFn(
      node.body as WorkflowSequenceNode,
      ctx,
      expressionCtx,
      frame.frameId,
      frame.path,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failFrame(frame, ctx, message);
    return { status: 'failed', error: message };
  }

  switch (bodyOutcome.status) {
    case 'failed': {
      await failFrame(frame, ctx, bodyOutcome.error);
      return { status: 'failed', error: bodyOutcome.error };
    }
    case 'cancelled': {
      await cancelFrame(frame, ctx);
      return { status: 'cancelled' };
    }
    case 'paused': {
      return bodyOutcome;
    }
    case 'skipped':
    case 'completed': {
      return undefined;
    }
  }
}

// -----------------------------------------------------------------
// Gate evaluation
// -----------------------------------------------------------------

/**
 * Evaluate the loop gate handler and return its outcome, applying the
 * max-rounds override when needed.
 *
 * Returns a terminal {@link NodeOutcome} when gate input evaluation
 * fails, or the resolved gate outcome and effective round count.
 * @param node - Loop node providing gate configuration.
 * @param round - Zero-based round index (converted to 1-based for the handler).
 * @param ctx - Runtime context.
 * @param expressionCtx - Expression context for gate input evaluation.
 * @param gateHandler - Resolved gate handler function.
 * @returns Gate outcome or a terminal failure outcome.
 */
function evaluateGate(
  node: WorkflowLoopNode,
  round: number,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  gateHandler: LoopGateHandler,
): LoopGateOutcome | NodeOutcome {
  let gateInput: JsonValue = null;
  if (node.gate.input !== undefined) {
    try {
      const scope = buildRuntimeExpressionScope(expressionCtx);
      gateInput = evaluateSync(node.gate.input, scope) as JsonValue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'failed',
        error: `Loop node '${node.id}': gate input expression evaluation failed: ${message}`,
      };
    }
  }

  const gateConfig: JsonValue = node.gate.config ?? null;
  const gateOutcome = gateHandler(gateInput, gateConfig, {
    executionId: ctx.executionId,
    nodeId: node.id,
    round: round + 1,
    maxRounds: node.maxRounds,
  });

  // Override loop to escalate when max rounds exhausted.
  if (gateOutcome.kind === 'loop' && round + 1 >= node.maxRounds) {
    return { kind: 'escalate', reason: 'max_rounds_reached' };
  }

  return gateOutcome;
}

// -----------------------------------------------------------------
// Loop node executor
// -----------------------------------------------------------------

/**
 * Execute a `loop` node by running its body sequence up to `maxRounds`
 * times, evaluating the gate handler after each round to determine
 * whether to continue, pass, or escalate.
 *
 * **Execution flow:**
 * 1. Start at round 0 (0-based internally, 1-based in gate context).
 * 2. Create a per-round iteration frame, execute the body sequence.
 * 3. After the body completes, evaluate the gate handler.
 * 4. On `pass`: complete with a pass outcome.
 * 5. On `escalate` without escalation config: complete immediately.
 * 6. On `escalate` with escalation config: open a gate suspension
 *    (in-process or exit-based) and wait for resolution.
 * 7. On `loop`: increment round and re-enter unless `maxRounds` is
 *    reached, in which case the runtime overrides with an escalation.
 *
 * **Resume support:**
 * When the execution is re-dispatched (e.g., after an escalation gate
 * is resolved), previously completed round frames are reused via
 * {@link findReusableResumeFrame} so body sequences are not re-executed.
 * The escalation gate is resolved from persisted state on re-entry.
 * @param node - The loop node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the loop container frame.
 * @param parentPath - Frame-ID path including the container.
 * @returns Terminal execution outcome for the loop node.
 */
export async function executeLoopNode(
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) return { status: 'cancelled' };

  const gateHandler = ctx.runtimeLoopGates.get(node.gate.handler);
  if (gateHandler === undefined) {
    return {
      status: 'failed',
      error: `Loop node '${node.id}': no gate handler registered for '${node.gate.handler}'`,
    };
  }

  const { round: startRound, bodyOutputs } = replayResumedRounds(ctx, node, parentFrameId);
  let round = startRound;

  // Check for persisted escalation gate on re-entry.
  if (round > 0 && node.gate.escalation !== undefined && ctx.suspensionStrategy !== 'wait-in-process') {
    const gateOutcome: LoopGateOutcome = { kind: 'escalate', reason: 'resumed_from_gate' };
    const earlyOutcome = await resolvePersistedEscalationGate(
      ctx,
      node,
      parentFrameId,
      gateOutcome,
      round,
      bodyOutputs,
    );
    if (earlyOutcome !== undefined) return earlyOutcome;
  }

  // Main loop.
  while (true) {
    if (ctx.signal.aborted) return { status: 'cancelled' };

    const bodyResult = await executeRoundBody(
      node,
      round,
      ctx,
      expressionCtx,
      executeSequenceFn,
      parentFrameId,
      parentPath,
    );
    if (bodyResult.terminal) return bodyResult.outcome;
    bodyOutputs.push(bodyResult.output as JsonValue);

    const gateResult = evaluateGate(node, round, ctx, expressionCtx, gateHandler);
    if ('status' in gateResult) return gateResult;

    if (gateResult.kind === 'pass') {
      return {
        status: 'completed',
        output: buildLoopOutput('pass', round + 1, gateResult, bodyOutputs),
      };
    }
    if (gateResult.kind === 'escalate') {
      if (node.gate.escalation !== undefined) {
        return openEscalationGate(node, ctx, expressionCtx, parentFrameId, gateResult, round + 1, bodyOutputs);
      }
      return {
        status: 'completed',
        output: buildLoopOutput('escalate', round + 1, gateResult, bodyOutputs),
      };
    }

    round++;
  }
}

// -----------------------------------------------------------------
// Resume frame replay
// -----------------------------------------------------------------

/**
 * Result of replaying previously completed round frames.
 * Contains the first round index to execute fresh and the replayed body outputs.
 */
interface ReplayedRoundsResult {
  /** Zero-based index of the first round that needs fresh execution. */
  readonly round: number;
  /** Body outputs collected from replayed frames (mutable for the caller to append to). */
  readonly bodyOutputs: JsonValue[];
}

/**
 * Replay previously completed round frames from the resume index,
 * collecting their outputs without re-executing body sequences.
 * @param ctx - Runtime context with optional resume frames.
 * @param node - Loop node for frame matching.
 * @param parentFrameId - Loop container frame ID.
 * @returns The first round index to execute fresh and the body outputs replayed.
 */
function replayResumedRounds(ctx: RuntimeContext, node: WorkflowLoopNode, parentFrameId: string): ReplayedRoundsResult {
  if (ctx.resumeFrames === undefined) {
    return { round: 0, bodyOutputs: [] };
  }
  let round = 0;
  const bodyOutputs: JsonValue[] = [];
  while (true) {
    const frame = findReusableResumeFrame(ctx.resumeFrames, node.id, {
      parentFrameId,
      iteration: round,
    });
    if (frame === undefined) break;
    bodyOutputs.push((frame.output ?? null) as JsonValue);
    round++;
  }
  return { round, bodyOutputs };
}

// -----------------------------------------------------------------
// Output construction
// -----------------------------------------------------------------

/**
 * Build a {@link LoopOutput} record from the loop execution state.
 * @param outcome - Whether the loop exited via pass or escalate.
 * @param rounds - Total number of rounds executed (1-based).
 * @param lastGateOutcome - The gate outcome that terminated the loop.
 * @param bodyOutputs - Per-round body outputs in execution order.
 * @param resumeData - Optional resume data from a resolved escalation gate.
 * @returns JSON-serializable loop output.
 */
export function buildLoopOutput(
  outcome: 'pass' | 'escalate',
  rounds: number,
  lastGateOutcome: LoopGateOutcome,
  bodyOutputs: readonly JsonValue[],
  resumeData?: JsonValue,
): LoopOutput {
  return {
    outcome,
    rounds,
    lastGateOutcome,
    bodyOutputs,
    ...(resumeData !== undefined ? { resumeData } : {}),
  };
}
