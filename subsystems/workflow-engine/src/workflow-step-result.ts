import type { IMakaioBus } from '@makaio/bus-core';
import type { IStepRunner, SpanRecord, StepRunResult, WorkflowStepType } from '@makaio/contracts';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import type { ActiveExecution } from './types.js';
import { markStepFailed } from './workflow-execution-finalizer.js';
import { emitBeforeStepStart } from './step-lifecycle.js';

/** Terminal outcome produced by one executor-managed step. */
export type StepExecutionOutcome =
  | { status: 'completed' | 'skipped' }
  | { status: 'failed'; error: string; failedStepId: string };

/** Failed step outcome with the originating step id attached. */
export type FailedStepExecutionOutcome = Extract<StepExecutionOutcome, { status: 'failed' }> & { stepId: string };

type LifecycleManagedStepRunner = IStepRunner & {
  readonly managesWorkflowLifecycle?: boolean;
};

/**
 * Check whether the runner still owns workflow state mutation internally.
 * @param runner - Step runner to inspect.
 * @returns True when the runner owns step lifecycle side effects.
 */
export function runnerManagesWorkflowLifecycle(runner: IStepRunner): boolean {
  return (runner as LifecycleManagedStepRunner).managesWorkflowLifecycle === true;
}

/**
 * Serialize a step input or output value for state and span storage.
 * @param value - Value to serialize.
 * @returns String representation, or undefined when no value is present.
 */
export function stringifyStepValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Persist initial state for runners that return pure results instead of mutating execution state.
 * @param bus - Runtime bus.
 * @param active - Active execution state.
 * @param stepId - Step identifier.
 */
export async function prepareRunnerManagedStep(
  bus: IMakaioBus,
  active: ActiveExecution,
  stepId: string,
): Promise<void> {
  const step = active.stepMap.get(stepId);
  if (!step || step.type === 'for-each') throw new Error(`Executable step not found: ${stepId}`);

  await emitBeforeStepStart(bus, active.execution.id, step);
  if (active.execution.status !== 'running') return;

  const stepState = active.execution.steps[stepId];
  stepState.status = step.type === 'gate' ? 'waiting' : 'running';
  stepState.startedAt = Date.now();
  await bus.request(WorkflowStorageSubjects.setExecution, { execution: active.execution });
  await bus.emit(WorkflowSubjects.step.started, {
    executionId: active.execution.id,
    stepId,
    stepType: step.type,
    sessionId: active.execution.coordinatorSessionId,
  });
}

/**
 * Apply a pure runner result to workflow state, lifecycle events, and span storage.
 * @param bus - Runtime bus.
 * @param active - Active execution state.
 * @param stepId - Step identifier.
 * @param result - Runner result to apply.
 * @param resolvedInputs - Expression context passed to the runner.
 * @returns Structured executor outcome.
 */
export async function applyStepRunResult(
  bus: IMakaioBus,
  active: ActiveExecution,
  stepId: string,
  result: StepRunResult,
  resolvedInputs: Record<string, unknown>,
): Promise<StepExecutionOutcome> {
  const step = active.stepMap.get(stepId);
  if (!step || step.type === 'for-each') throw new Error(`Executable step not found: ${stepId}`);

  const stepState = active.execution.steps[stepId];
  const output = stringifyStepValue(result.output);
  if (active.execution.status !== 'running') {
    return { status: 'failed', error: 'Execution no longer running', failedStepId: stepId };
  }

  if (result.status === 'completed') {
    if (stepState.status !== 'completed') {
      stepState.status = 'completed';
      stepState.result = output;
      stepState.completedAt = Date.now();
      await bus.request(WorkflowStorageSubjects.setExecution, { execution: active.execution });
      await bus.emit(WorkflowSubjects.step.completed, {
        executionId: active.execution.id,
        stepId,
        stepType: step.type,
        result: output,
        duration: result.telemetry.duration,
      });
    }
    await persistStepSpan(bus, active, stepId, 'completed', resolvedInputs, output, result.telemetry);
    return { status: 'completed' };
  }

  const error = result.error ?? `Step failed: ${stepId}`;
  if (stepState.status !== 'failed' && active.execution.status === 'running') {
    await markStepFailed({
      bus,
      execution: active.execution,
      executionId: active.execution.id,
      stepId,
      stepType: step.type,
      stepState,
      error,
    });
  }
  await persistStepSpan(bus, active, stepId, 'failed', resolvedInputs, output, result.telemetry);
  return { status: 'failed', error: stepState.error ?? error, failedStepId: stepId };
}

/**
 * Persist one workflow step span.
 * @param bus - Runtime bus.
 * @param active - Active execution state.
 * @param stepId - Step identifier.
 * @param status - Span status.
 * @param resolvedInputs - Expression context passed to the runner.
 * @param output - Serialized output.
 * @param telemetry - Optional runner telemetry.
 */
export async function persistStepSpan(
  bus: IMakaioBus,
  active: ActiveExecution,
  stepId: string,
  status: SpanRecord['status'],
  resolvedInputs: Record<string, unknown> = {},
  output?: string,
  telemetry?: StepRunResult['telemetry'],
): Promise<void> {
  const step = active.stepMap.get(stepId);
  if (!step || step.type === 'for-each') return;

  const stepState = active.execution.steps[stepId];
  const startedAt = stepState.startedAt;
  const completedAt = stepState.completedAt;
  const durationMs =
    telemetry?.duration ??
    (startedAt !== undefined && completedAt !== undefined ? Math.max(0, completedAt - startedAt) : undefined);

  await bus.request(WorkflowStorageSubjects.setSpan, {
    span: {
      executionId: active.execution.id,
      stepId,
      stepType: step.type as WorkflowStepType,
      status,
      startedAt,
      completedAt,
      durationMs,
      inputTokens: telemetry?.tokenUsage?.input,
      outputTokens: telemetry?.tokenUsage?.output,
      estimatedCost: telemetry?.estimatedCost,
      toolCallCount: telemetry?.toolCalls,
      input: stringifyStepValue(resolvedInputs),
      output,
    },
  });
}
