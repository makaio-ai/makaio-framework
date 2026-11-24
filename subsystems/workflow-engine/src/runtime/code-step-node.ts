import type { CallContext } from '@makaio/core';
import { JsonValueSchema, type CodeStepData, type CodeStepHandler, type WorkflowCodeStepNode } from '@makaio/contracts';
import { abortableWait } from '@makaio/utils';
import type { RuntimeContext } from './runtime-context.js';
import type { CallerLocalStepOutcome } from './caller-local-step-runner.js';
import { bindCallerLocalStepCapabilities } from './caller-local-step-capabilities.js';

/** The step's process scope could not be closed or its temporary workspace removed. */
export class LocalStepProcessCleanupError extends Error {
  /** @param cause - Host cleanup failure, kept internal to the runner. */
  public constructor(cause: unknown) {
    super('Local step process cleanup failed', { cause });
    this.name = 'LocalStepProcessCleanupError';
  }
}

/**
 * Invoke a registered Code Step under the execution's local capabilities.
 * @param call - Original call context for the run.
 * @param node - Code Step to invoke.
 * @param ctx - Runtime that owns the workflow and its handlers.
 * @param data - Run and iteration data prepared for this occurrence.
 * @param handler - Code loaded in the caller process.
 * @returns Terminal execution outcome.
 */
export async function executeCallerLocalCodeStep(
  call: CallContext,
  node: WorkflowCodeStepNode,
  ctx: RuntimeContext,
  data: CodeStepData,
  handler: CodeStepHandler | undefined,
): Promise<CallerLocalStepOutcome> {
  if (ctx.signal.aborted) return { status: 'cancelled' };
  if (handler === undefined) {
    return {
      status: 'failed',
      error: 'handlerUnavailable',
      detail: `No handler registered for code step '${node.id}'`,
    };
  }
  const { request, launchProcess, close } = bindCallerLocalStepCapabilities({
    bus: ctx.bus,
    call,
    signal: ctx.signal,
    workspace: ctx.platformContext.repoPath,
    stepId: node.id,
    env: ctx.env,
    timeoutMs: ctx.stepTimeoutMs,
  });
  let outcome: CallerLocalStepOutcome;
  try {
    const work = Promise.resolve().then(() => {
      ctx.signal.throwIfAborted();
      return handler({ ...data, signal: ctx.signal, request, launchProcess });
    });
    const output = JsonValueSchema.parse(await abortableWait(work, ctx.signal));
    outcome = { status: 'completed', output };
  } catch (error) {
    outcome = {
      status: 'failed',
      error: 'stepExecutionFailed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    await close();
  } catch (error) {
    throw new LocalStepProcessCleanupError(error);
  }
  return ctx.signal.aborted ? { status: 'cancelled' } : outcome;
}
