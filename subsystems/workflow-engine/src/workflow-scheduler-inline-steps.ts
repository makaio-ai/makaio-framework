import type { WorkflowExpressionContext } from '@makaio/expression';
import type { ActiveExecution, WorkflowSchedulerDeps } from './types.js';
import { executeGateStep } from './workflow-step-executors.js';
import { applyStepRunResult, prepareRunnerManagedStep, type StepExecutionOutcome } from './workflow-step-result.js';

/**
 * Run an inline step callback with scheduler-owned cancellation registration.
 * @param deps - Scheduler dependency bundle.
 * @param executionId - Execution ID owning the step.
 * @param nodeId - Step ID to register.
 * @param run - Callback invoked with the step abort signal.
 * @returns Step run result produced by the callback.
 */
async function runInlineStepWithController<T>(
  deps: WorkflowSchedulerDeps,
  executionId: string,
  nodeId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const key = `${executionId}:${nodeId}`;
  deps.shellAbortControllers.set(key, controller);
  try {
    return await run(controller.signal);
  } finally {
    deps.shellAbortControllers.delete(key);
  }
}

/**
 * Execute a gate-type step within the scheduler.
 *
 * In the worker context (`deps.runGateStep` is set), the gate lifecycle is
 * forwarded to the injected callback. In the main-process context, the gate
 * coordinator handles approval/rejection directly via `executeGateStep`.
 * @param deps - Scheduler dependency bundle.
 * @param executionId - Execution ID owning the step.
 * @param active - Active execution state.
 * @param nodeId - Gate step ID.
 * @param resolvedInputs - Expression context resolved from prior step outputs.
 * @returns Step execution outcome.
 */
export async function runGateInlineStep(
  deps: WorkflowSchedulerDeps,
  executionId: string,
  active: ActiveExecution,
  nodeId: string,
  resolvedInputs: WorkflowExpressionContext,
): Promise<StepExecutionOutcome> {
  if (deps.runGateStep) {
    const runGateStep = deps.runGateStep;
    // Worker path: delegate the full gate lifecycle to the injected callback.
    // The scheduler manages step lifecycle (state, persistence, events) via
    // prepareRunnerManagedStep + applyStepRunResult, matching the shell/agent path.
    await prepareRunnerManagedStep(deps.bus, active, nodeId);
    if (active.execution.status !== 'running') {
      return { status: 'failed', error: 'Execution cancelled', failedStepId: nodeId };
    }
    const gateResult = await runInlineStepWithController(deps, executionId, nodeId, (signal) =>
      runGateStep(executionId, nodeId, resolvedInputs, signal),
    );
    return applyStepRunResult(deps.bus, active, nodeId, gateResult, resolvedInputs);
  }

  // Main-process path: coordinator manages gate lifecycle internally.
  const gateResult = await executeGateStep(deps, executionId, nodeId);
  return applyStepRunResult(deps.bus, active, nodeId, gateResult, resolvedInputs);
}

/**
 * Execute a function-type step within the scheduler (worker context only).
 *
 * Function steps run the authored JavaScript function directly in the worker
 * process. If no `runFunctionStep` callback is provided the step fails
 * immediately, which is the correct behaviour in the main-process executor
 * where function steps are not supported.
 * @param deps - Scheduler dependency bundle.
 * @param executionId - Execution ID owning the step.
 * @param active - Active execution state.
 * @param nodeId - Function step ID.
 * @param resolvedInputs - Expression context resolved from prior step outputs.
 * @returns Step execution outcome.
 */
export async function runFunctionInlineStep(
  deps: WorkflowSchedulerDeps,
  executionId: string,
  active: ActiveExecution,
  nodeId: string,
  resolvedInputs: WorkflowExpressionContext,
): Promise<StepExecutionOutcome> {
  if (!deps.runFunctionStep) {
    return {
      status: 'failed',
      error: `Function step '${nodeId}' cannot be executed: no runFunctionStep callback provided`,
      failedStepId: nodeId,
    };
  }

  await prepareRunnerManagedStep(deps.bus, active, nodeId);
  if (active.execution.status !== 'running') {
    return { status: 'failed', error: 'Execution cancelled', failedStepId: nodeId };
  }

  const runFunctionStep = deps.runFunctionStep;
  const fnResult = await runInlineStepWithController(deps, executionId, nodeId, (signal) =>
    runFunctionStep(executionId, nodeId, resolvedInputs, signal),
  );

  return applyStepRunResult(deps.bus, active, nodeId, fnResult, resolvedInputs);
}
