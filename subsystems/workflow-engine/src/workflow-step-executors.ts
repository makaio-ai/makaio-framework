import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  SubagentSubjects,
  type AgentWorkflowStep,
  type ShellWorkflowStep,
  type StepRunResult,
  type StepState,
  type WorkflowExecution,
} from '@makaio/contracts';
import { resolveTemplate, type ExpressionContext } from '@makaio/expression';
import { WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { runShellStep } from './executor-helpers.js';
import { markStepFailed } from './workflow-execution-finalizer.js';
import { emitBeforeStepStart } from './step-lifecycle.js';
import type { ActiveExecution, ExecutorConfig } from './types.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';

/** Runtime dependencies injected into standalone step executor functions. */
export interface StepExecutorDeps {
  bus: IMakaioBus;
  activeExecutions: Map<string, ActiveExecution>;
  shellAbortControllers: Map<string, AbortController>;
  gateCoordinator: WorkflowGateCoordinator;
  config: ExecutorConfig;
}

/**
 * Build a failed StepRunResult with telemetry.
 * @param error - Error message to include
 * @param startedAt - Start timestamp for duration calculation
 * @returns Failed step run result
 */
function failResult(error: string, startedAt: number): StepRunResult {
  return { status: 'failed', error, telemetry: { duration: Date.now() - startedAt } };
}

/**
 * Build a completed StepRunResult with telemetry.
 * @param startedAt - Start timestamp for duration calculation
 * @param output - Optional step output string
 * @returns Completed step run result
 */
function okResult(startedAt: number, output?: string): StepRunResult {
  return { status: 'completed', output, telemetry: { duration: Date.now() - startedAt } };
}

/**
 * Build the expression context from all started steps and trigger payload.
 * Includes all non-pending steps so that `if` conditions can reference preceding step status.
 * Merges optional for-each item/index context when the step is inside a for-each.
 * @param execution - Current workflow execution state
 * @param activeExecutions - Active execution map for for-each context lookup
 * @param stepId - Optional step ID to resolve for-each item/index context
 * @returns Expression context for jexl evaluation and template interpolation
 */
export function buildExpressionContext(
  execution: WorkflowExecution,
  activeExecutions: Map<string, ActiveExecution>,
  stepId?: string,
): ExpressionContext {
  const ctx: ExpressionContext = {
    trigger: execution.triggerPayload ?? {},
    steps: Object.fromEntries(
      Object.entries(execution.steps)
        .filter(([, state]) => state.status !== 'pending')
        .map(([id, state]) => [id, { result: state.result, status: state.status }]),
    ),
    inputs: execution.inputs,
  };
  if (stepId) {
    const active = activeExecutions.get(execution.id);
    const forEachCtx = active?.stepContext.get(stepId);
    if (forEachCtx) {
      ctx.item = forEachCtx.item;
      ctx.index = forEachCtx.index;
    }
  }
  return ctx;
}

/**
 * Await subagent completion and settle the step state based on the result.
 * Extracted from executeAgentStep to keep the parent under complexity limits.
 * @param bus - Message bus
 * @param execution - Current workflow execution
 * @param executionId - Execution ID
 * @param stepId - Step ID
 * @param stepState - Mutable step state to settle
 * @param step - Agent step definition (for onComplete config)
 * @param subagentId - Spawned subagent ID
 * @param config - Executor configuration
 */
async function awaitAndSettleSubagent(
  bus: IMakaioBus,
  execution: WorkflowExecution,
  executionId: string,
  stepId: string,
  stepState: StepState,
  step: AgentWorkflowStep,
  subagentId: string,
  config: ExecutorConfig,
): Promise<void> {
  const result = await bus.request(SubagentSubjects.await, {
    subagentId,
    timeoutMs: config.stepTimeoutMs,
  });

  if (execution.status !== 'running') return;

  if (result.status !== 'completed') {
    await bus.request(SubagentSubjects.kill, { subagentId }).catch(() => {});
  }

  if (result.status === 'failed') {
    await markStepFailed(
      bus,
      execution,
      executionId,
      stepId,
      step.type,
      stepState,
      result.error ?? 'Subagent execution failed',
    );
    return;
  }

  if (result.status !== 'completed') {
    await markStepFailed(
      bus,
      execution,
      executionId,
      stepId,
      step.type,
      stepState,
      `Subagent ended with unexpected status: ${result.status}`,
    );
    return;
  }

  stepState.status = 'completed';
  stepState.result = step.onComplete?.extract === 'none' ? '' : (result.result ?? '');
  stepState.completedAt = Date.now();
  const duration = stepState.completedAt - (stepState.startedAt ?? stepState.completedAt);
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.step.completed, {
    executionId,
    stepId,
    stepType: step.type,
    result: stepState.result,
    duration,
  });
}

/**
 * Execute an agent step by spawning a subagent with the resolved prompt.
 * @param deps - Executor dependencies (bus, maps, config)
 * @param executionId - The execution ID
 * @param stepId - The step ID to execute
 * @returns Step run result with status, output, and telemetry
 */
export async function executeAgentStep(
  deps: StepExecutorDeps,
  executionId: string,
  stepId: string,
): Promise<StepRunResult> {
  const startedAt = Date.now();
  const { bus, activeExecutions, config } = deps;
  const active = activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  const { execution, workflow, stepMap } = active;
  const step = stepMap.get(stepId);
  if (!step || step.type !== 'agent') return failResult(`Agent step not found: ${stepId}`, startedAt);

  const stepState = execution.steps[stepId];

  // Track outside the try so the catch block can kill an already-spawned subagent.
  let subagentId: string | undefined;

  try {
    // Emit beforeStart before any state mutation so interceptors can reject the step.
    await emitBeforeStepStart(bus, executionId, step);

    stepState.status = 'running';
    stepState.startedAt = Date.now();
    await bus.request(WorkflowStorageSubjects.setExecution, { execution });

    const resolvedPrompt = resolveTemplate(step.prompt, buildExpressionContext(execution, activeExecutions, stepId));

    const currentActive = activeExecutions.get(executionId);
    if (!currentActive || currentActive.execution.status !== 'running') {
      return failResult('Execution cancelled', startedAt);
    }

    const spawnResult = await bus.requestOptional(SubagentSubjects.spawn, {
      parentSessionId: execution.coordinatorSessionId!,
      config: {
        task: resolvedPrompt,
        contextMode: 'fork',
        adapterName: step.adapter,
        model: step.model,
        executionTargetId: step.executionTargetId ?? workflow.defaultExecutionTargetId,
        responseSchema: step.outputSchema,
      },
      depth: 0,
    });
    if (!spawnResult.handled) {
      await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, 'Subagent system not available');
      return failResult('Subagent system not available', startedAt);
    }
    subagentId = spawnResult.data.subagentId;

    stepState.subagentId = subagentId;
    await bus.request(WorkflowStorageSubjects.setExecution, { execution });

    // Re-check after persisting subagentId: cancellation may have arrived during spawn.
    // Now that subagentId is recorded, we can kill the just-spawned subagent.
    if (execution.status !== 'running') {
      await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow cancelled' }).catch(() => {});
      return failResult('Execution cancelled', startedAt);
    }

    await bus.emit(WorkflowSubjects.step.started, {
      executionId,
      stepId,
      stepType: step.type,
      sessionId: execution.coordinatorSessionId ?? '',
      subagentId,
    });

    await awaitAndSettleSubagent(bus, execution, executionId, stepId, stepState, step, subagentId, config);
  } catch (error) {
    // On cancellation the caller handles cleanup; avoid double-failing.
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);
    if (subagentId !== undefined) {
      await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Step execution error' }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, message);
    return failResult(message, startedAt);
  }

  // Re-read via indexer to break control-flow narrowing from the `stepState.status = 'running'`
  // assignment above: awaitAndSettleSubagent mutates the status but TypeScript can't track that.
  const settledState = execution.steps[stepId];
  if (settledState?.status === 'completed') return okResult(startedAt, settledState.result ?? '');
  return failResult(settledState?.error ?? `Step failed: ${stepId}`, startedAt);
}

/**
 * Execute a shell step by running an external process via `execFile`.
 * @param deps - Executor dependencies (bus, maps, config)
 * @param executionId - The execution ID
 * @param stepId - The step ID to execute
 * @returns Step run result with status, output, and telemetry
 */
export async function executeShellStep(
  deps: StepExecutorDeps,
  executionId: string,
  stepId: string,
): Promise<StepRunResult> {
  const startedAt = Date.now();
  const { bus, activeExecutions, shellAbortControllers } = deps;
  const active = activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  const { execution, stepMap } = active;
  const step = stepMap.get(stepId);
  if (!step || step.type !== 'shell') return failResult(`Shell step not found: ${stepId}`, startedAt);

  const stepState = execution.steps[stepId];

  // Register the AbortController before state mutation so any cancellation that
  // arrives after setExecution resolves can abort the shell process.
  const controller = new AbortController();
  const stepKey = `${executionId}:${stepId}`;
  shellAbortControllers.set(stepKey, controller);

  let outcome: Awaited<ReturnType<typeof runShellStep>>;
  try {
    // Emit beforeStart before any state mutation so interceptors can reject the step.
    await emitBeforeStepStart(bus, executionId, step);

    stepState.status = 'running';
    stepState.startedAt = Date.now();

    // The controller remains registered for the entire launch window so
    // cancellation can abort a process as soon as one exists, and failures in
    // that same window still release the cancellation handle.
    await bus.request(WorkflowStorageSubjects.setExecution, { execution });

    const { session } = await bus.request(SessionSubjects.get, {
      sessionId: execution.coordinatorSessionId!,
    });
    const workspaceRoot = session?.targetWorkingDirectory ?? process.cwd();

    await bus.emit(WorkflowSubjects.step.started, {
      executionId,
      stepId,
      stepType: step.type,
      sessionId: execution.coordinatorSessionId ?? '',
    });

    const expressionContext = buildExpressionContext(execution, activeExecutions, stepId);

    outcome = await runShellStep({
      step: step as ShellWorkflowStep,
      workspaceRoot,
      expressionContext,
      signal: controller.signal,
    });
  } catch (error) {
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);
    const message = error instanceof Error ? error.message : String(error);
    await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, message);
    return failResult(message, startedAt);
  } finally {
    shellAbortControllers.delete(stepKey);
  }

  if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  if (outcome.status === 'failed') {
    await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, outcome.error);
    return failResult(outcome.error, startedAt);
  }

  stepState.status = 'completed';
  stepState.result = outcome.stdout;
  stepState.completedAt = Date.now();
  const duration = stepState.completedAt - (stepState.startedAt ?? stepState.completedAt);
  await bus.request(WorkflowStorageSubjects.setExecution, { execution });
  await bus.emit(WorkflowSubjects.step.completed, {
    executionId,
    stepId,
    stepType: step.type,
    result: outcome.stdout,
    duration,
  });
  return okResult(startedAt, outcome.stdout);
}

/**
 * Execute a gate step — pause for human approval.
 * Emits a gate request event, awaits user response or timeout, then completes or fails the step.
 * @param deps - Executor dependencies (bus, maps, config)
 * @param executionId - The execution ID
 * @param stepId - The step ID to execute
 * @returns Step run result with status, output, and telemetry
 */
export async function executeGateStep(
  deps: StepExecutorDeps,
  executionId: string,
  stepId: string,
): Promise<StepRunResult> {
  const startedAt = Date.now();
  const { bus, activeExecutions, gateCoordinator } = deps;
  const active = activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  const { execution, workflow, stepMap } = active;
  const step = stepMap.get(stepId);
  if (!step || step.type !== 'gate') return failResult(`Gate step not found: ${stepId}`, startedAt);

  const stepState = execution.steps[stepId];

  try {
    await emitBeforeStepStart(bus, executionId, step);

    stepState.status = 'waiting';
    stepState.startedAt = Date.now();
    await bus.request(WorkflowStorageSubjects.setExecution, { execution });

    const expressionContext = buildExpressionContext(execution, activeExecutions, stepId);
    const message = resolveTemplate(step.prompt, expressionContext);
    const title = step.title ? resolveTemplate(step.title, expressionContext) : 'Workflow Approval Required';
    const openedAt = Date.now();
    const timeoutMs = typeof step.timeoutMs === 'number' ? step.timeoutMs : null;
    const resolutionPromise = gateCoordinator.awaitResolution(executionId, stepId, step.autoAction, timeoutMs);

    await bus.emit(WorkflowSubjects.gate.requested, {
      executionId,
      stepId,
      stepType: step.type,
      workflowId: workflow.id,
      workflowName: workflow.name,
      title,
      message,
      autoAction: step.autoAction,
      timeoutMs,
      openedAt,
    });

    const { action, source } = await resolutionPromise;

    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

    await bus.emit(WorkflowSubjects.gate.resolved, {
      executionId,
      stepId,
      stepType: step.type,
      action,
      source,
    });

    if (action === 'approve') {
      stepState.status = 'completed';
      stepState.result = source === 'user' ? 'Approved by user' : 'Auto-approved (timeout)';
      stepState.completedAt = Date.now();
      await bus.request(WorkflowStorageSubjects.setExecution, { execution });
      const duration = stepState.completedAt - (stepState.startedAt ?? stepState.completedAt);
      await bus.emit(WorkflowSubjects.step.completed, {
        executionId,
        stepId,
        stepType: step.type,
        result: stepState.result,
        duration,
      });
      return okResult(startedAt, stepState.result);
    }

    const reason = source === 'user' ? 'Rejected by user' : 'Auto-rejected (timeout)';
    await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, reason);
    return failResult(reason, startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markStepFailed(bus, execution, executionId, stepId, step.type, stepState, message);
    return failResult(message, startedAt);
  }
}
