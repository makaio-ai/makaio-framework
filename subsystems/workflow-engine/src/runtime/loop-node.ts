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
import { findReusableResumeFrame, mergeFrameOutput } from './resume-frames.js';
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
type RoundBodyResult =
  | { terminal: true; outcome: NodeOutcome }
  | {
      terminal: false;
      output: JsonValue | undefined;
      replayed: boolean;
      gateExpressionCtx: PrimitiveExpressionContext;
    };

/** Round frame statuses that can be reused while redispatching a parked loop node. */
const ROUND_RESUME_STATUSES = new Set<WorkflowFrameState['status']>(['completed', 'running']);

/**
 * Execute the body sequence for a single loop round.
 *
 * Creates a per-round iteration frame (or reuses a persisted one from a
 * prior execution), runs the body sequence, and either returns the
 * extracted body output on success or a terminal {@link NodeOutcome} on
 * failure/cancellation/pause.
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
  const resumeFrame = findReusableResumeFrame(ctx.resumeFrames, node.id, {
    parentFrameId,
    iteration: round,
    statuses: ROUND_RESUME_STATUSES,
  });

  if (resumeFrame?.status === 'completed') {
    return {
      terminal: false,
      output: (resumeFrame.output ?? null) as JsonValue,
      replayed: true,
      gateExpressionCtx: buildLoopGateExpressionContext(node, ctx, expressionCtx, resumeFrame.frameId),
    };
  }

  const frame =
    resumeFrame ??
    ctx.createFrame({
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

  if (resumeFrame === undefined) {
    await startFrame(frame, ctx);
  }

  const bodyOutcome = await runBodySequence(node, frame, ctx, expressionCtx, executeSequenceFn);
  if (bodyOutcome !== undefined) {
    return { terminal: true, outcome: bodyOutcome };
  }

  const bodyOutput = extractLastSequenceOutput(node.body as WorkflowSequenceNode, frame.frameId, ctx);
  await completeFrame(frame, ctx, bodyOutput);
  return {
    terminal: false,
    output: bodyOutput,
    replayed: false,
    gateExpressionCtx: buildLoopGateExpressionContext(node, ctx, expressionCtx, frame.frameId),
  };
}

/**
 * Build the expression context visible to the loop gate after a body round.
 *
 * `executeSequence` keeps body-local frame outputs in its local context, so the
 * loop reconstructs the same public frame view from the runtime frame registry.
 * @param node - Loop node whose body frame outputs should be exposed.
 * @param ctx - Runtime context containing completed body frames.
 * @param baseCtx - Outer expression context inherited by the loop.
 * @param roundFrameId - Frame ID of this loop round.
 * @returns Expression context that includes body node frame outputs.
 */
function buildLoopGateExpressionContext(
  node: WorkflowLoopNode,
  ctx: RuntimeContext,
  baseCtx: PrimitiveExpressionContext,
  roundFrameId: string,
): PrimitiveExpressionContext {
  let gateCtx = baseCtx;
  for (const bodyNode of (node.body as WorkflowSequenceNode).nodes) {
    const frame = ctx
      .getFramesByNodeId(bodyNode.id)
      .find((candidate) => candidate.parentFrameId === roundFrameId && candidate.status === 'completed');
    if (frame !== undefined) {
      gateCtx = mergeFrameOutput(gateCtx, bodyNode.id, {
        status: 'completed',
        ...(frame.output !== undefined ? { output: frame.output } : {}),
      });
    }
  }
  return gateCtx;
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

  const bodyOutputs: JsonValue[] = [];
  let round = 0;

  // Main loop — executeRoundBody handles frame resume internally.
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

    // Replayed rounds already passed the gate in a prior execution — skip re-evaluation.
    if (bodyResult.replayed) {
      round++;
      if (node.gate.escalation !== undefined && ctx.suspensionStrategy !== 'wait-in-process') {
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
      continue;
    }

    const gateResult = evaluateGate(node, round, ctx, bodyResult.gateExpressionCtx, gateHandler);
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
