import type { CodeStepHandler, IStepRunner, StepRunResult } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { executeCallerLocalCodeStep, LocalStepProcessCleanupError } from './code-step-node.js';
import { executeCallerLocalAgentStep } from './delegate-node.js';
import type { RuntimeContext } from './runtime-context.js';

/** Step result before the caller-local runner attaches its telemetry. */
export type CallerLocalStepOutcome = Omit<StepRunResult, 'telemetry'>;

/**
 * Bind the local CLI or coordinator run to its own code and host capabilities.
 * This executes in the caller's process without a prepared checkout.
 * @param call - The context of the local run.
 * @param handlers - Code already loaded by the local caller.
 * @returns An execution port bound when the local runtime is constructed.
 */
export function createCallerLocalStepRunner(
  call: CallContext,
  handlers: ReadonlyMap<string, CodeStepHandler>,
): (runtime: RuntimeContext) => IStepRunner {
  return (root) => ({
    run: async (config, signal) => {
      const start = performance.now();
      const ctx = root.signal === signal ? root : root.withSignal(signal);
      let outcome: CallerLocalStepOutcome;
      try {
        outcome =
          config.stepType === 'code-step'
            ? await executeCallerLocalCodeStep(
                call,
                config.stepDefinition,
                ctx,
                config.data,
                handlers.get(config.stepId),
              )
            : await executeCallerLocalAgentStep(
                call,
                config.stepDefinition,
                ctx,
                config.resolvedPrompt,
                config.frameId,
              );
      } catch (error) {
        if (!(error instanceof LocalStepProcessCleanupError)) throw error;
        outcome = { status: 'failed', error: 'stepProcessCleanupFailed' };
      }
      return { ...outcome, telemetry: { duration: performance.now() - start } };
    },
  });
}
