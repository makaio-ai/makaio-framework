import type { JsonValue, WorkflowParallelNode, WorkflowSequenceNode } from '@makaio/contracts';
import type { ExecuteSequenceFn, NodeOutcome } from './node-execution.js';
import type { PrimitiveExpressionContext, RuntimeContext } from './runtime-context.js';
import { cancelFrame, completeFrame, failFrame, startFrame } from './node-execution.js';
import { extractLastSequenceOutput } from './iterate-helpers.js';

// ─────────────────────────────────────────────────────────────
// Parallel execution mode
// ─────────────────────────────────────────────────────────────

/**
 * Execution mode for a parallel node.
 *
 * - `'all-settled'`: Run all branches concurrently and collect every result,
 *   regardless of individual branch success or failure. The parallel node
 *   itself always completes (never fails) unless the execution is cancelled.
 * - `'fail-fast'`: Cancel all sibling branches as soon as one branch fails.
 *   The parallel node fails immediately with the first branch error.
 *
 * {@link WorkflowParallelNode.mode} carries the serialized mode for persisted
 * definitions. Direct callers may omit it and receive the same `all-settled`
 * default used by the dispatcher.
 */
export type ParallelExecutionMode = 'all-settled' | 'fail-fast';

// ─────────────────────────────────────────────────────────────
// Per-branch outcome
// ─────────────────────────────────────────────────────────────

/**
 * Terminal outcome recorded for a single parallel branch.
 *
 * Mirrors the JavaScript `Promise.allSettled` shape so callers can
 * inspect per-branch results without pattern-matching on `NodeOutcome`.
 */
export type BranchSettled =
  | { readonly status: 'fulfilled'; readonly value: JsonValue | undefined }
  | { readonly status: 'rejected'; readonly reason: string }
  | { readonly status: 'cancelled' };

// ─────────────────────────────────────────────────────────────
// Parallel node executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a `parallel` node by running all named branches concurrently.
 *
 * Each branch gets its own child frame so the GUI/WorkLog can track
 * per-branch state independently. The parallel container itself also
 * holds a frame (created by the caller in the sequence loop) whose
 * `parentFrameId` and `parentPath` are forwarded here.
 *
 * **`all-settled` mode (default):**
 * All branches run to completion (or failure) before the parallel node
 * resolves. The output is a {@link ParallelOutput} record keyed by branch
 * name. The parallel node itself always completes — individual branch
 * failures are captured in the per-branch result, not propagated as a
 * node failure.
 *
 * **`fail-fast` mode:**
 * If any branch fails, an internal {@link AbortController} cancels all
 * sibling branches. The parallel node then fails with the first branch
 * error.
 *
 * In both modes, cancellation of the outer {@link RuntimeContext.signal}
 * propagates immediately: all in-flight branch frames are cancelled.
 * @param node - The parallel node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context forwarded to each branch.
 * @param executeSequenceFn - Injected sequence executor (breaks circular dependency).
 * @param parentFrameId - Frame ID of the parallel container frame.
 * @param parentPath - Frame-ID path of ancestor frames (including the parallel container).
 * @param mode - Execution mode; defaults to `'all-settled'`.
 * @returns Terminal execution outcome for the parallel node as a whole.
 */
export async function executeParallelNode(
  node: WorkflowParallelNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
  mode: ParallelExecutionMode = 'all-settled',
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  const branchEntries = Object.entries(node.branches) as Array<[string, WorkflowSequenceNode]>;

  if (branchEntries.length === 0) {
    // A parallel node with no branches trivially completes with an empty result.
    return { status: 'completed', output: buildParallelOutput({}, mode) };
  }

  // Internal abort controller for fail-fast cancellation.
  // The parent signal is chained so outer cancellation always propagates.
  const failFastController = new AbortController();
  const combinedSignal = mode === 'fail-fast' ? linkSignals(ctx.signal, failFastController.signal) : ctx.signal;

  // Create a child RuntimeContext that uses the combined signal for fail-fast.
  // In all-settled mode the original ctx is used directly.
  const branchCtx: RuntimeContext = mode === 'fail-fast' ? ctx.withSignal(combinedSignal) : ctx;

  const branchPromises = branchEntries.map(([branchKey, branchSequence]) =>
    runBranch(branchKey, branchSequence, node, branchCtx, expressionCtx, executeSequenceFn, parentFrameId, parentPath),
  );

  if (mode === 'all-settled') {
    const results = await Promise.all(branchPromises);
    const settled = buildSettledMap(branchEntries, results);
    return { status: 'completed', output: buildParallelOutput(settled, mode) };
  }

  // fail-fast: race all branches; cancel siblings on the first failure.
  const results = await runFailFast(branchEntries, branchPromises, failFastController);
  if (results.type === 'cancelled') {
    return { status: 'cancelled' };
  }
  if (results.type === 'failed') {
    return { status: 'failed', error: results.error };
  }
  const settled = buildSettledMap(branchEntries, results.outcomes);
  return { status: 'completed', output: buildParallelOutput(settled, mode) };
}

// ─────────────────────────────────────────────────────────────
// Branch runner
// ─────────────────────────────────────────────────────────────

/**
 * Run a single parallel branch and return its settled outcome.
 *
 * Creates a child frame for the branch, emits frame lifecycle events, and
 * delegates to the sequence executor. The frame uses `branchKey` so the
 * GUI/WorkLog can correlate per-branch state.
 * @param branchKey - Branch name from `node.branches`.
 * @param branchSequence - Sequence node to execute for this branch.
 * @param parallelNode - Parent parallel node (for nodeId reference).
 * @param ctx - Runtime context (may be the combined-signal context for fail-fast).
 * @param expressionCtx - Expression evaluation context forwarded to the sequence.
 * @param executeSequenceFn - Injected sequence executor.
 * @param parentFrameId - Frame ID of the parallel container frame.
 * @param parentPath - Frame-ID path of the parallel container (inclusive).
 * @returns Settled outcome for this branch.
 */
async function runBranch(
  branchKey: string,
  branchSequence: WorkflowSequenceNode,
  parallelNode: WorkflowParallelNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  executeSequenceFn: ExecuteSequenceFn,
  parentFrameId: string,
  parentPath: string[],
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  // Create a dedicated frame for this branch so the GUI can track it.
  const frame = ctx.createFrame({
    nodeId: parallelNode.id,
    nodeType: 'parallel',
    path: parentPath,
    parentFrameId,
    branchKey,
  });

  if (ctx.signal.aborted) {
    await cancelFrame(frame, ctx);
    return { status: 'cancelled' };
  }

  await startFrame(frame, ctx);

  let outcome: NodeOutcome;
  try {
    outcome = await executeSequenceFn(branchSequence, ctx, expressionCtx, frame.frameId, frame.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failFrame(frame, ctx, message);
    return { status: 'failed', error: message };
  }

  // Map the sequence outcome to a frame terminal state.
  switch (outcome.status) {
    case 'completed': {
      // Extract the last branch node's output from the frame registry so the
      // parallel aggregate can surface per-branch results.
      const branchOutput = extractLastSequenceOutput(branchSequence, frame.frameId, ctx);
      await completeFrame(frame, ctx, branchOutput);
      return { status: 'completed', output: branchOutput };
    }
    case 'skipped': {
      // Sequences only return 'skipped' if all nodes were skipped.
      // Treat as completed for the branch aggregate with no output.
      await completeFrame(frame, ctx);
      return { status: 'completed' };
    }
    case 'cancelled': {
      await cancelFrame(frame, ctx);
      return { status: 'cancelled' };
    }
    case 'failed': {
      await failFrame(frame, ctx, outcome.error);
      return { status: 'failed', error: outcome.error };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Fail-fast runner
// ─────────────────────────────────────────────────────────────

/**
 * Discriminated result for the fail-fast parallel run.
 */
type FailFastResult =
  | { readonly type: 'completed'; readonly outcomes: NodeOutcome[] }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'cancelled' };

/**
 * Await all branch promises in fail-fast mode.
 *
 * Monitors each branch promise. If any branch fails, immediately fires the
 * failFastController so sibling branches receive a cancellation signal.
 * Waits for all branches to settle before returning so no promises are
 * left dangling.
 * @param branchEntries - Ordered branch entries for index alignment.
 * @param branchPromises - In-flight branch promise for each entry.
 * @param failFastController - Controller whose signal is injected into branch contexts.
 * @returns Discriminated result describing whether all branches completed,
 *   at least one failed, or the execution was cancelled.
 */
async function runFailFast(
  branchEntries: Array<[string, WorkflowSequenceNode]>,
  branchPromises: Promise<NodeOutcome>[],
  failFastController: AbortController,
): Promise<FailFastResult> {
  let firstError: string | undefined;

  // Wrap each branch promise to detect failures and cancel siblings.
  const monitored = branchPromises.map((p) =>
    p.then(
      (outcome) => {
        if (outcome.status === 'failed' && firstError === undefined) {
          firstError = outcome.error;
          failFastController.abort();
        }
        return outcome;
      },
      (thrown) => {
        // Unexpected rejection (should not happen since runBranch catches).
        const error = thrown instanceof Error ? thrown.message : String(thrown);
        if (firstError === undefined) {
          firstError = error;
          failFastController.abort();
        }
        return { status: 'failed' as const, error };
      },
    ),
  );

  const outcomes = await Promise.all(monitored);

  // Determine the aggregate result.
  const hasCancelled = outcomes.some((o) => o.status === 'cancelled');
  if (hasCancelled && firstError === undefined) {
    return { type: 'cancelled' };
  }
  if (firstError !== undefined) {
    return { type: 'failed', error: firstError };
  }
  return { type: 'completed', outcomes };
}

// ─────────────────────────────────────────────────────────────
// Output construction
// ─────────────────────────────────────────────────────────────

/**
 * Structured output produced by a completed parallel node.
 *
 * Keyed by branch name; each value is a {@link BranchSettled} record
 * describing whether the branch fulfilled (completed), was rejected
 * (failed), or was cancelled.
 */
export interface ParallelOutput {
  readonly mode: ParallelExecutionMode;
  readonly branches: Record<string, BranchSettled>;
}

/**
 * Build a {@link ParallelOutput} record from the settled branch map.
 * @param settled - Per-branch settled outcomes.
 * @param mode - The execution mode used for this parallel run.
 * @returns JSON-serializable parallel output.
 */
function buildParallelOutput(settled: Record<string, BranchSettled>, mode: ParallelExecutionMode): ParallelOutput {
  return { mode, branches: settled };
}

/**
 * Convert the ordered array of branch outcomes into a record keyed by branch name.
 * @param branchEntries - Ordered branch name + sequence pairs.
 * @param outcomes - Corresponding `NodeOutcome` for each branch.
 * @returns Per-branch settled outcome record.
 */
function buildSettledMap(
  branchEntries: Array<[string, WorkflowSequenceNode]>,
  outcomes: NodeOutcome[],
): Record<string, BranchSettled> {
  const settled: Record<string, BranchSettled> = {};
  for (let i = 0; i < branchEntries.length; i++) {
    const [branchKey] = branchEntries[i];
    const outcome = outcomes[i];
    settled[branchKey] = outcomeToSettled(outcome);
  }
  return settled;
}

/**
 * Convert a {@link NodeOutcome} to a {@link BranchSettled} record.
 * @param outcome - Branch execution outcome.
 * @returns Settled status for this branch.
 */
function outcomeToSettled(outcome: NodeOutcome): BranchSettled {
  switch (outcome.status) {
    case 'completed':
      return { status: 'fulfilled', value: outcome.output };
    case 'skipped':
      return { status: 'fulfilled', value: null };
    case 'cancelled':
      return { status: 'cancelled' };
    case 'failed':
      return { status: 'rejected', reason: outcome.error };
  }
}

// ─────────────────────────────────────────────────────────────
// Signal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create an AbortSignal that aborts when either input signal aborts.
 *
 * Uses `AbortSignal.any()` when available (Node ≥ 20) and falls back to
 * a manual listener chain for older environments.
 * @param outer - The execution-level abort signal.
 * @param inner - The fail-fast abort signal.
 * @returns A combined signal that aborts on the first trigger.
 */
function linkSignals(outer: AbortSignal, inner: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([outer, inner]);
  }
  // Fallback for environments without AbortSignal.any.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  outer.addEventListener('abort', abort, { once: true });
  inner.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
