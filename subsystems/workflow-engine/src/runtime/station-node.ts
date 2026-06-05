import { type JsonValue, type StationHandler, type WorkflowStationNode } from '@makaio/contracts';
import {
  buildPreviousStepsFromFrames,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { createArtifactContext } from '../artifact-context/update-artifact.js';
import { executeRoleSubagentNode } from './role-subagent-node.js';

// ─────────────────────────────────────────────────────────────
// Station node executor
// ─────────────────────────────────────────────────────────────

/**
 * Execute a `station` node by looking up and invoking its registered handler.
 *
 * The handler is resolved from `ctx.runtimeHandlers` by the node's own ID.
 * If no handler is registered and the serialized node carries a `role`, the
 * station executes through the role/subagent seam used by GUI-authored workflow
 * blocks. If neither execution path is available, the node fails with a
 * descriptive error rather than silently succeeding with no output.
 *
 * The handler receives a {@link StepContext} assembled from the current
 * execution state:
 * - `inputs` and `trigger` come from the execution record.
 * - `previousSteps` is derived from the expression context's `frames` map,
 *   keyed by node ID and shaped as {@link PreviousStepOutput}.
 * - Platform fields (`repoPath`, `makaioHome`, `os`, `arch`, `worktree`, `env`)
 *   come from the durable run context or worker config passed into
 *   {@link RuntimeContext}.
 * - `signal` forwards the execution's cooperative cancellation signal.
 * - `artifact` is injected when the workflow declares an artifact binding and
 *   the execution has a resolved {@link ArtifactBindingState}.
 * @param node - The station node to execute.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context (for previousSteps).
 * @param frameId - Frame ID of this station's frame (used for artifact event correlation).
 * @returns Terminal execution outcome for this station.
 */
export async function executeStationNode(
  node: WorkflowStationNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  // Abort check before invoking the handler.
  if (ctx.signal.aborted) {
    return { status: 'cancelled' };
  }

  // Build previousSteps from the expression context's terminal frame entries.
  const previousSteps = buildPreviousStepsFromFrames(expressionCtx.frames);

  const handler: StationHandler | undefined = ctx.runtimeHandlers.get(node.id);
  if (handler === undefined) {
    return executeRoleStationNode(node, ctx, expressionCtx);
  }

  // Build artifact context when the execution has an active artifact binding.
  const artifact =
    ctx.artifactBinding !== undefined && frameId !== undefined
      ? createArtifactContext({
          executionId: ctx.executionId,
          frameId,
          bindingState: ctx.artifactBinding,
          bus: ctx.bus,
        })
      : undefined;

  let output: JsonValue;
  try {
    output = await handler({
      // ── Platform fields ───────────────────────────────────────
      ...ctx.platformContext,
      env: ctx.env,
      // ── Execution identity ──────────────────────────────────
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      // ── Workflow inputs and trigger payload ─────────────────
      inputs: ctx.execution.inputs,
      config: ctx.execution.config ?? {},
      trigger: ctx.execution.triggerPayload ?? {},
      // ── Step dependency outputs ──────────────────────────────
      previousSteps,
      // ── Iterate context (present when inside iterate/iterate-chain) ──
      ...(expressionCtx.item !== undefined && { item: expressionCtx.item }),
      ...(expressionCtx.index !== undefined && { index: expressionCtx.index }),
      ...(expressionCtx.previous !== undefined && { previous: expressionCtx.previous }),
      // ── Cooperative cancellation ─────────────────────────────
      signal: ctx.signal,
      // ── Artifact context (present when a binding is configured) ──
      ...(artifact !== undefined && { artifact }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', error: message };
  }

  return { status: 'completed', output };
}

/**
 * Execute a serialized station node through the role/subagent seam.
 *
 * Code-authored station handlers are preferred when present. This path exists
 * for persisted or GUI-authored workflow definitions, where a station is
 * function-free and carries a role/prompt contract instead.
 * @param node - Station node without a registered runtime handler.
 * @param ctx - Execution-wide runtime context.
 * @param expressionCtx - Current expression evaluation context.
 * @returns Terminal execution outcome for the role-backed station.
 */
async function executeRoleStationNode(
  node: WorkflowStationNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
): Promise<NodeOutcome> {
  if (node.role === undefined) {
    return {
      status: 'failed',
      error: `No handler registered for station node '${node.id}'`,
    };
  }

  return executeRoleSubagentNode(
    {
      nodeId: node.id,
      nodeLabel: 'Station node',
      roleId: node.role,
      prompt: node.prompt,
      ...(node.outputSchema !== undefined ? { outputSchema: node.outputSchema } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
      unresolvedRoleError: `No runtime handler registered for station node '${node.id}', and role '${node.role}' could not be resolved`,
      unavailableRuntimeError: `Subagent runtime is not available for station node '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await station node '${node.id}'`,
      cancellationLabel: 'station',
    },
    ctx,
    expressionCtx,
  );
}
