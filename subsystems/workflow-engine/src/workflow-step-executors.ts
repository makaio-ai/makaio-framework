import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  SubagentSubjects,
  type AgentWorkflowStep,
  type ExecutableStepState,
  type JsonValue,
  type ShellWorkflowStep,
  type StepRunResult,
  type WorkflowStep,
  type WorkflowExecution,
} from '@makaio/contracts';
import { resolveTemplate, type WorkflowExpressionContext } from '@makaio/expression';
import { WorkflowSubjects } from './namespace.js';
import { runShellStep } from './executor-helpers.js';
import { markStepFailed } from './workflow-execution-finalizer.js';
import { emitBeforeStepStart } from './step-lifecycle.js';
import type { ActiveExecution, ExecutorConfig } from './types.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';
import { persistStepState } from './workflow-execution-persistence.js';
import { buildLocalStepAliases } from './workflow-scheduler-state.js';
import { resolveAgentSpawnConfig } from './agent-spawn-config.js';

type GateStep = Extract<WorkflowStep, { type: 'gate' }>;
type RunnableWorkflowStep = AgentWorkflowStep | ShellWorkflowStep | GateStep;

type StepPreamble<TStep extends RunnableWorkflowStep> = {
  execution: WorkflowExecution;
  workflow: ActiveExecution['workflow'];
  step: TStep;
  /** Always `ExecutableStepState` — verified by `getStepPreamble` which rejects for-each steps. */
  stepState: ExecutableStepState;
};

/**
 * Load and validate the shared execution state needed before running a step.
 * @param deps - Step executor dependencies.
 * @param executionId - Execution identifier.
 * @param stepId - Step identifier.
 * @param stepType - Expected executable step type.
 * @param startedAt - Timestamp used for early failure telemetry.
 * @returns Step preamble for the requested type, or a failed run result.
 */
function getStepPreamble<TType extends RunnableWorkflowStep['type']>(
  deps: StepExecutorDeps,
  executionId: string,
  stepId: string,
  stepType: TType,
  startedAt: number,
): StepPreamble<Extract<RunnableWorkflowStep, { type: TType }>> | StepRunResult {
  const active = deps.activeExecutions.get(executionId);
  if (!active || active.execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  const step = active.stepMap.get(stepId);
  if (!step || step.type !== stepType) return failResult(`${stepType} step not found: ${stepId}`, startedAt);

  // The step is a runnable (non-for-each) type, so its state is ExecutableStepState.
  const rawState = active.execution.steps[stepId];
  if (!rawState || rawState.kind !== 'executable') {
    return failResult(`Unexpected state kind for step: ${stepId}`, startedAt);
  }

  return {
    execution: active.execution,
    workflow: active.workflow,
    step: step as Extract<WorkflowStep, { type: TType }> & Extract<RunnableWorkflowStep, { type: TType }>,
    stepState: rawState,
  };
}

/**
 * Check whether a preamble lookup returned a runner result instead of state.
 * @param value - Candidate preamble or failed step result.
 * @returns True when the value is a StepRunResult.
 */
function isStepRunResult(value: StepRunResult | StepPreamble<RunnableWorkflowStep>): value is StepRunResult {
  return 'status' in value;
}

/** Runtime dependencies injected into standalone step executor functions. */
export interface StepExecutorDeps {
  bus: IMakaioBus;
  activeExecutions: Map<string, ActiveExecution>;
  shellAbortControllers: Map<string, AbortController>;
  gateCoordinator: WorkflowGateCoordinator;
  config: ExecutorConfig;
}

/**
 * Build a failed {@link StepRunResult} with duration telemetry.
 * @param error - Error message
 * @param startedAt - Start timestamp for duration calculation
 * @returns Failed step run result
 */
export function failResult(error: string, startedAt: number): StepRunResult {
  return { status: 'failed', error, telemetry: { duration: Date.now() - startedAt } };
}

/**
 * Build a completed {@link StepRunResult} with duration telemetry.
 * @param startedAt - Start timestamp for duration calculation
 * @param output - Optional step output value (JSON-serializable)
 * @returns Completed step run result
 */
function okResult(startedAt: number, output?: JsonValue): StepRunResult {
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
): WorkflowExpressionContext {
  const baseSteps = Object.fromEntries(
    Object.entries(execution.steps)
      .filter(([, state]) => state.status !== 'pending')
      .map(([id, state]) => [
        id,
        {
          result: state.kind === 'executable' ? state.result : undefined,
          status: state.status,
        },
      ]),
  );
  const localStepAliases = stepId ? buildLocalStepAliases(stepId, baseSteps) : {};
  const ctx: WorkflowExpressionContext = {
    trigger: execution.triggerPayload ?? {},
    steps: { ...baseSteps, ...localStepAliases },
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
  stepState: ExecutableStepState,
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
    await markStepFailed({
      bus,
      execution,
      executionId,
      stepId,
      stepType: step.type,
      stepState,
      error: result.error ?? 'Subagent execution failed',
    });
    return;
  }

  if (result.status !== 'completed') {
    await markStepFailed({
      bus,
      execution,
      executionId,
      stepId,
      stepType: step.type,
      stepState,
      error: `Subagent ended with unexpected status: ${result.status}`,
    });
    return;
  }

  stepState.status = 'completed';
  stepState.result = step.onComplete?.extract === 'none' ? '' : (result.result ?? '');
  stepState.completedAt = Date.now();
  const duration = stepState.completedAt - (stepState.startedAt ?? stepState.completedAt);
  await persistStepState(bus, execution, stepId);
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
  const preamble = getStepPreamble(deps, executionId, stepId, 'agent', startedAt);
  if (isStepRunResult(preamble)) return preamble;

  const { execution, workflow, step, stepState } = preamble;

  // Track outside the try so the catch block can kill an already-spawned subagent.
  let subagentId: string | undefined;

  try {
    // Emit beforeStart before any state mutation so interceptors can reject the step.
    await emitBeforeStepStart(bus, executionId, step);

    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

    stepState.status = 'running';
    stepState.startedAt = Date.now();
    await persistStepState(bus, execution, stepId);

    const resolvedPrompt = resolveTemplate(step.prompt, buildExpressionContext(execution, activeExecutions, stepId));

    const currentActive = activeExecutions.get(executionId);
    if (!currentActive || currentActive.execution.status !== 'running') {
      return failResult('Execution cancelled', startedAt);
    }

    const agentConfig = await resolveAgentSpawnConfig(bus, step);
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

    const spawnResult = await bus.requestOptional(SubagentSubjects.spawn, {
      parentSessionId: execution.coordinatorSessionId!,
      config: {
        task: resolvedPrompt,
        contextMode: agentConfig.contextMode,
        adapterName: agentConfig.adapterName,
        model: agentConfig.model,
        harnessId: agentConfig.harnessId,
        systemPrompt: agentConfig.systemPrompt,
        providerContext: agentConfig.providerContext,
        executionTargetId: step.executionTargetId ?? workflow.defaultExecutionTargetId,
        responseSchema: step.outputSchema,
      },
      depth: 0,
    });
    if (!spawnResult.handled) {
      await markStepFailed({
        bus,
        execution,
        executionId,
        stepId,
        stepType: step.type,
        stepState,
        error: 'Subagent system not available',
      });
      return failResult('Subagent system not available', startedAt);
    }
    subagentId = spawnResult.data.subagentId;

    stepState.subagentId = subagentId;
    await persistStepState(bus, execution, stepId);

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
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);
  } catch (error) {
    // On cancellation the caller handles cleanup; avoid double-failing.
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);
    if (subagentId !== undefined) {
      await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Step execution error' }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    await markStepFailed({ bus, execution, executionId, stepId, stepType: step.type, stepState, error: message });
    return failResult(message, startedAt);
  }

  const settledState = execution.steps[stepId] as ExecutableStepState | undefined;
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
  const preamble = getStepPreamble(deps, executionId, stepId, 'shell', startedAt);
  if (isStepRunResult(preamble)) return preamble;

  const { execution, step, stepState } = preamble;

  // Register the AbortController before state mutation so any cancellation that
  // arrives after the running state persists can abort the shell process.
  const controller = new AbortController();
  const stepKey = `${executionId}:${stepId}`;
  shellAbortControllers.set(stepKey, controller);

  let outcome: Awaited<ReturnType<typeof runShellStep>>;
  try {
    // Emit beforeStart before any state mutation so interceptors can reject the step.
    await emitBeforeStepStart(bus, executionId, step);

    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

    stepState.status = 'running';
    stepState.startedAt = Date.now();

    await persistStepState(bus, execution, stepId);

    const { session } = await bus.request(SessionSubjects.get, {
      sessionId: execution.coordinatorSessionId!,
    });
    const workspaceRoot = session?.targetWorkingDirectory ?? deps.config.platformDefaults.cwd;

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
    await markStepFailed({ bus, execution, executionId, stepId, stepType: step.type, stepState, error: message });
    return failResult(message, startedAt);
  } finally {
    shellAbortControllers.delete(stepKey);
  }

  if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

  if (outcome.status === 'failed') {
    await markStepFailed({
      bus,
      execution,
      executionId,
      stepId,
      stepType: step.type,
      stepState,
      error: outcome.error,
    });
    return failResult(outcome.error, startedAt);
  }

  stepState.status = 'completed';
  stepState.result = outcome.stdout;
  stepState.completedAt = Date.now();
  const duration = stepState.completedAt - (stepState.startedAt ?? stepState.completedAt);
  await persistStepState(bus, execution, stepId);
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
  const preamble = getStepPreamble(deps, executionId, stepId, 'gate', startedAt);
  if (isStepRunResult(preamble)) return preamble;

  const { execution, workflow, step, stepState } = preamble;

  try {
    await emitBeforeStepStart(bus, executionId, step);

    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);

    stepState.status = 'waiting';
    stepState.startedAt = Date.now();
    await persistStepState(bus, execution, stepId);

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
      await persistStepState(bus, execution, stepId);
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
    await markStepFailed({ bus, execution, executionId, stepId, stepType: step.type, stepState, error: reason });
    return failResult(reason, startedAt);
  } catch (error) {
    gateCoordinator.resolveForCancellation(executionId, stepId);
    if (execution.status !== 'running') return failResult('Execution cancelled', startedAt);
    const message = error instanceof Error ? error.message : String(error);
    await markStepFailed({ bus, execution, executionId, stepId, stepType: step.type, stepState, error: message });
    return failResult(message, startedAt);
  }
}
