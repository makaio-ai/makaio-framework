import {
  type JsonValue,
  type ResponseSchemaDescriptor,
  type StationHandler,
  type WorkflowProgressUpdate,
  type WorkflowStationNode,
} from '@makaio/contracts';
import {
  buildPreviousStepsFromFrames,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { createArtifactContext } from '../artifact-context/update-artifact.js';
import { createWorkflowStateContext } from './workflow-state-context.js';
import { executeRoleSubagentNode } from './role-subagent-node.js';
import { WorkflowSchemas, WorkflowSubjects } from '../namespace.js';

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
 * - `state` is injected when the workflow declares a state contract via the
 *   `state` field on the definition, providing `get()` and `update()` for
 *   run-scoped mutable state.
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
    return executeRoleStationNode(node, ctx, expressionCtx, frameId);
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

  // Build state context when the workflow declares a state contract.
  const stateCtx =
    ctx.definition.state !== undefined ? createWorkflowStateContext(ctx.executionId, ctx.bus) : undefined;

  /**
   * Emit a structured progress signal to the `execution.progress` bus subject.
   *
   * Observer failures are swallowed so a misbehaving subscriber cannot abort the
   * station handler. Producer-side schema validation errors still propagate and
   * fail the station because they indicate an invalid progress contract.
   *
   * When `frameId` is absent (e.g. in isolated unit tests that call the executor
   * directly without a frame registry), the emit is skipped — progress signals
   * require frame identity for routing.
   * @param update - The progress payload to emit.
   */
  async function updateProgress(update: WorkflowProgressUpdate): Promise<void> {
    if (frameId === undefined) {
      console.warn(`[station-node] updateProgress called without frameId for node '${node.id}'; skipping emit`);
      return;
    }
    const payload = WorkflowSchemas['execution.progress'].parse({
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      frameId,
      nodeId: node.id,
      progress: update,
      emittedAt: Date.now(),
    });
    try {
      await ctx.bus.emit(WorkflowSubjects.execution.progress, payload);
    } catch (error) {
      // The producer payload is parsed before emit; rejections here are
      // observer-side delivery failures and must not abort the station.
      console.error(`[station-node] execution.progress observer failed for ${node.id}:`, error);
    }
  }

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
      // ── State context (present when a state contract is declared) ──
      ...(stateCtx !== undefined && { state: stateCtx }),
      // ── Runtime bus ──────────────────────────────────────────
      bus: ctx.bus,
      // ── Progress reporting ────────────────────────────────────
      updateProgress,
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
 * @param frameId - Frame ID of this station's frame, forwarded for session link emission.
 * @returns Terminal execution outcome for the role-backed station.
 */
async function executeRoleStationNode(
  node: WorkflowStationNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  frameId?: string,
): Promise<NodeOutcome> {
  if (node.role === undefined) {
    return {
      status: 'failed',
      error: `No handler registered for station node '${node.id}'`,
    };
  }

  const outputSchema: ResponseSchemaDescriptor | undefined =
    node.outputSchema !== undefined ? { schema: node.outputSchema } : undefined;
  return executeRoleSubagentNode(
    {
      nodeId: node.id,
      nodeLabel: 'Station node',
      roleId: node.role,
      prompt: node.prompt,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
      ...(node.completion !== undefined ? { completion: node.completion } : {}),
      unresolvedRoleError: `No runtime handler registered for station node '${node.id}', and role '${node.role}' could not be resolved`,
      unavailableRuntimeError: `Subagent runtime is not available for station node '${node.id}'`,
      unavailableAwaitError: `Subagent runtime cannot await station node '${node.id}'`,
      cancellationLabel: 'station',
      ...(frameId !== undefined ? { frameId } : {}),
    },
    ctx,
    expressionCtx,
  );
}
