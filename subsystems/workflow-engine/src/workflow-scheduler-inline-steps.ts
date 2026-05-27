import { JsonValueSchema, WORKFLOW_CANCELLED_REASON, type BusRequestWorkflowStep } from '@makaio/contracts';
import type { WorkflowExpressionContext } from '@makaio/expression';
import { resolveTemplatesInObject } from '@makaio/expression';
import { isRequestSchema } from '@makaio/bus-core';
import type { SubjectDefinition } from '@makaio/core';
import type { ActiveExecution, WorkflowSchedulerDeps } from './types.js';
import { executeGateStep } from './workflow-step-executors.js';
import { applyStepRunResult, prepareRunnerManagedStep, type StepExecutionOutcome } from './workflow-step-result.js';
import { cancelExecution } from './workflow-execution-finalizer.js';

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
 * Resolve a fully-qualified subject string to a registered request subject.
 *
 * Looks up the subject in the bus namespace registry, then verifies it is:
 * - Registered as a request subject (has `request` + `response` schemas).
 * - Not channel-only (channel subjects are point-to-point and cannot be used
 *   for general workflow RPC).
 *
 * Returns a minimal `SubjectDefinition`-compatible value that the bus `request()`
 * method can dispatch with correct runtime routing (local flag, namespace, subject key).
 * @param deps - Scheduler dependency bundle providing bus access.
 * @param fullSubject - Fully-qualified subject string, e.g. `github:app.issue.create`.
 * @returns Result discriminated union — either a resolved subject definition or an
 *   error string suitable for step failure reporting.
 */
function resolveRegisteredRequestSubject(
  deps: WorkflowSchedulerDeps,
  fullSubject: string,
): { ok: true; subject: SubjectDefinition } | { ok: false; error: string } {
  const registry = deps.bus.getContext().namespaceRegistry;
  const registered = registry.getRegisteredSubject(fullSubject);

  if (!registered) {
    return {
      ok: false,
      error: `Bus request subject is not registered: ${fullSubject}`,
    };
  }

  if (!isRequestSchema(registered.schema)) {
    return {
      ok: false,
      error: `Bus request subject is not a request subject: ${fullSubject}`,
    };
  }

  if (registered.channel) {
    return {
      ok: false,
      error: `Bus request subject is channel-only and cannot be used in a bus-request step: ${fullSubject}`,
    };
  }

  // Build a minimal SubjectDefinition-compatible object using the registered
  // runtime metadata. The `payload` field is a compile-time type parameter only
  // and is never read at runtime by the bus dispatch path.
  const subjectDef: SubjectDefinition = {
    $meta: {
      namespace: registered.namespace,
      payload: {} as SubjectDefinition['$meta']['payload'],
      isRequest: true,
      local: registered.local,
      channel: false,
    },
    subject: registered.subject,
  };

  return { ok: true, subject: subjectDef };
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
    if (gateResult.status === 'failed' && gateResult.error === WORKFLOW_CANCELLED_REASON) {
      await cancelExecution(deps, executionId, WORKFLOW_CANCELLED_REASON);
      return { status: 'failed', error: WORKFLOW_CANCELLED_REASON, failedStepId: nodeId };
    }
    return applyStepRunResult(deps.bus, active, nodeId, gateResult, resolvedInputs);
  }

  // Main-process path: coordinator manages gate lifecycle internally.
  const gateResult = await executeGateStep(deps, executionId, nodeId);
  return applyStepRunResult(deps.bus, active, nodeId, gateResult, resolvedInputs);
}

/**
 * Execute a `bus-request`-type step within the scheduler.
 *
 * Resolves the step's subject against the namespace registry, resolves payload
 * templates against the expression context, dispatches `bus.request()`, and
 * validates the response is JSON-serializable before storing it as the step result.
 * @param deps - Scheduler dependency bundle.
 * @param executionId - Execution ID owning the step.
 * @param active - Active execution state.
 * @param nodeId - Bus-request step ID.
 * @param resolvedInputs - Expression context resolved from prior step outputs.
 * @returns Step execution outcome.
 */
export async function runBusRequestInlineStep(
  deps: WorkflowSchedulerDeps,
  executionId: string,
  active: ActiveExecution,
  nodeId: string,
  resolvedInputs: WorkflowExpressionContext,
): Promise<StepExecutionOutcome> {
  const step = active.stepMap.get(nodeId) as BusRequestWorkflowStep | undefined;
  if (!step || step.type !== 'bus-request') {
    return {
      status: 'failed',
      error: `Bus-request step definition not found: ${nodeId}`,
      failedStepId: nodeId,
    };
  }

  const subjectResult = resolveRegisteredRequestSubject(deps, step.subject);
  if (!subjectResult.ok) {
    return { status: 'failed', error: subjectResult.error, failedStepId: nodeId };
  }
  const subjectDef = subjectResult.subject;

  await prepareRunnerManagedStep(deps.bus, active, nodeId);
  if (active.execution.status !== 'running') {
    return { status: 'failed', error: 'Execution cancelled', failedStepId: nodeId };
  }

  const timeout = step.timeoutMs ?? deps.config.stepTimeoutMs;
  const resolvedPayload = resolveTemplatesInObject(step.payload ?? {}, resolvedInputs, {
    omitUndefinedProperties: true,
  });

  const stepStartTime = Date.now();
  let rawResponse: unknown;
  try {
    rawResponse = await runInlineStepWithController(deps, executionId, nodeId, (signal) =>
      deps.bus.request(subjectDef, resolvedPayload, { timeout, signal }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return applyStepRunResult(
      deps.bus,
      active,
      nodeId,
      { status: 'failed', error: message, telemetry: { duration: Date.now() - stepStartTime } },
      resolvedInputs,
    );
  }

  const parseResult = JsonValueSchema.safeParse(rawResponse);
  if (!parseResult.success) {
    return applyStepRunResult(
      deps.bus,
      active,
      nodeId,
      {
        status: 'failed',
        error: `Bus-request step '${nodeId}' response is not JSON-serializable`,
        telemetry: { duration: Date.now() - stepStartTime },
      },
      resolvedInputs,
    );
  }

  return applyStepRunResult(
    deps.bus,
    active,
    nodeId,
    { status: 'completed', output: parseResult.data, telemetry: { duration: Date.now() - stepStartTime } },
    resolvedInputs,
  );
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
