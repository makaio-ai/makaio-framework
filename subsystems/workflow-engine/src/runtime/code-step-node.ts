import type { CallContext } from '@makaio/core';
import { CodeStepDataSchema, type WorkflowCodeStepNode } from '@makaio/contracts';
import { abortableWait } from '@makaio/utils';
import {
  buildPreviousStepsFromFrames,
  type PrimitiveExpressionContext,
  type RuntimeContext,
} from './runtime-context.js';
import type { NodeOutcome } from './node-execution.js';
import { bindCallerLocalStepCapabilities } from './caller-local-step-capabilities.js';

/**
 * Invoke a registered Code Step under the execution's local capabilities.
 * @param call - Original call context for the run.
 * @param node - Code Step to invoke.
 * @param ctx - Runtime that owns the workflow and its handlers.
 * @param expressionCtx - Current sequence or iteration state.
 * @param _frameId - Frame already managed by the node dispatcher.
 * @returns Terminal execution outcome.
 */
export async function executeCodeStepNode(
  call: CallContext,
  node: WorkflowCodeStepNode,
  ctx: RuntimeContext,
  expressionCtx: PrimitiveExpressionContext,
  _frameId?: string,
): Promise<NodeOutcome> {
  if (ctx.signal.aborted) return { status: 'cancelled' };
  const handler = ctx.runtimeHandlers.get(node.id);
  if (handler === undefined) return { status: 'failed', error: `No handler registered for code step '${node.id}'` };
  const { request, launchProcess, close } = bindCallerLocalStepCapabilities({
    bus: ctx.bus,
    call,
    signal: ctx.signal,
    workspace: ctx.platformContext.repoPath,
    stepId: node.id,
    env: ctx.env,
    timeoutMs: ctx.stepTimeoutMs,
  });
  let outcome: NodeOutcome;
  try {
    const data = CodeStepDataSchema.parse({
      executionId: ctx.executionId,
      workflowId: ctx.workflowId,
      inputs: ctx.execution.inputs,
      config: ctx.execution.config ?? {},
      previousSteps: buildPreviousStepsFromFrames(expressionCtx.frames),
      ...(expressionCtx.item !== undefined && { item: expressionCtx.item }),
      ...(expressionCtx.index !== undefined && { index: expressionCtx.index }),
      ...(expressionCtx.previous !== undefined && { previous: expressionCtx.previous }),
    });
    const work = Promise.resolve().then(() => {
      ctx.signal.throwIfAborted();
      return handler({ ...data, signal: ctx.signal, request, launchProcess });
    });
    const output = await abortableWait(work, ctx.signal);
    outcome = { status: 'completed', output };
  } catch (error) {
    outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await close();
    return ctx.signal.aborted ? { status: 'cancelled' } : outcome;
  } catch {
    return { status: 'failed', error: 'makaio.step-process-cleanup-failed' };
  }
}
