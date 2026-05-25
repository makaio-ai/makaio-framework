import {
  ContextModeSchema,
  SubagentSubjects,
  WorkflowSubjects,
  type AgentWorkflowStep,
  type StepRunConfig,
  type StepRunResult,
} from '@makaio/contracts';
import { resolveTemplate } from '@makaio/expression';
import { buildWorkflowExpressionContextFromResolvedInputs } from '@makaio/subsystem-workflow-engine';
import type { WorkerBusHandle } from './worker-boot.js';
import type { WorkerContributions } from './worker-contributions.js';

/**
 * Build a failed legacy worker agent result with duration telemetry.
 * @param error - Failure message to expose on the step result.
 * @param startedAt - Step start timestamp from performance.now().
 * @returns Failed step run result.
 */
function failedWorkerAgentResult(error: string, startedAt: number): StepRunResult {
  return { status: 'failed', error, telemetry: { duration: performance.now() - startedAt } };
}

/**
 * Spawn a subagent for a legacy worker agent step.
 * @param handle - Worker bus handle used for role resolution and subagent spawning.
 * @param config - Step runner config with coordinator session and resolved inputs.
 * @param step - Agent step definition to execute.
 * @param startedAt - Step start timestamp for failure telemetry.
 * @returns Spawn result or a terminal failed step result.
 */
async function spawnWorkerSubagent(
  handle: WorkerBusHandle,
  config: StepRunConfig,
  step: AgentWorkflowStep,
  startedAt: number,
): Promise<{ status: 'spawned'; subagentId: string } | { status: 'failed'; result: StepRunResult }> {
  const agentConfig = step.role
    ? await handle.bus.request(WorkflowSubjects.resolveRole, { roleId: step.role })
    : {
        adapterName: step.adapter,
        model: step.model,
        harnessId: step.harnessId,
        contextMode: step.contextMode ?? ContextModeSchema.enum.fresh,
      };

  const spawn = await handle.bus.requestOptional(SubagentSubjects.spawn, {
    parentSessionId: config.coordinatorSessionId,
    config: {
      task: resolveTemplate(step.prompt, buildWorkflowExpressionContextFromResolvedInputs(config.resolvedInputs)),
      contextMode: agentConfig.contextMode ?? ContextModeSchema.enum.fresh,
      adapterName: agentConfig.adapterName,
      model: agentConfig.model,
      harnessId: agentConfig.harnessId,
      systemPrompt: 'systemPrompt' in agentConfig ? agentConfig.systemPrompt : undefined,
      providerContext: 'providerContext' in agentConfig ? agentConfig.providerContext : undefined,
      executionTargetId: step.executionTargetId,
      responseSchema: step.outputSchema,
    },
    depth: 0,
  });

  if (!spawn.handled) {
    return { status: 'failed', result: failedWorkerAgentResult('Subagent system not available', startedAt) };
  }

  return { status: 'spawned', subagentId: spawn.data.subagentId };
}

/**
 * Await a spawned subagent and translate its terminal status into a step result.
 * @param handle - Worker bus handle.
 * @param step - Agent step definition controlling output extraction.
 * @param signal - Abort signal for cooperative cancellation.
 * @param subagentId - Spawned subagent identifier.
 * @param startedAt - Step start timestamp for duration telemetry.
 * @returns Terminal step result.
 */
async function awaitWorkerSubagent(
  handle: WorkerBusHandle,
  step: AgentWorkflowStep,
  signal: AbortSignal,
  subagentId: string,
  startedAt: number,
): Promise<StepRunResult> {
  let abortedWhileWaiting = false;
  const onAbort = (): void => {
    abortedWhileWaiting = true;
    void handle.bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow cancelled' }).catch(() => {});
  };

  try {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return failedWorkerAgentResult('Workflow cancelled', startedAt);
    }

    const awaitResult = await handle.bus.request(SubagentSubjects.await, { subagentId });
    const duration = performance.now() - startedAt;
    if (abortedWhileWaiting || signal.aborted) {
      return { status: 'failed', error: 'Workflow cancelled', telemetry: { duration } };
    }
    if (awaitResult.status !== 'completed') {
      await handle.bus.request(SubagentSubjects.kill, { subagentId }).catch(() => {});
      return {
        status: 'failed',
        error: awaitResult.error ?? `Subagent ended with status: ${awaitResult.status}`,
        telemetry: { duration },
      };
    }
    return {
      status: 'completed',
      output: step.onComplete?.extract === 'none' ? '' : (awaitResult.result ?? ''),
      telemetry: { duration },
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute an agent workflow step inside the worker process.
 *
 * Legacy step-level workers now delegate agent execution through the same
 * subagent protocol as workflow-level workers, preserving role resolution,
 * context mode, system prompt, provider context, and cancellation semantics.
 * @param handle - Worker bus handle with an active bus instance.
 * @param config - Step run configuration describing the agent step.
 * @param signal - Abort signal for cooperative cancellation.
 * @param _contributions - Deprecated worker-local contributions, retained for call-site compatibility.
 * @returns Step run result with the agent's output and telemetry.
 */
export async function runWorkerAgentStep(
  handle: WorkerBusHandle,
  config: StepRunConfig,
  signal: AbortSignal,
  _contributions?: WorkerContributions,
): Promise<StepRunResult> {
  if (config.stepType !== 'agent') {
    return {
      status: 'failed',
      error: `Expected agent step but received '${config.stepType}'`,
      telemetry: { duration: 0 },
    };
  }

  if (config.stepDefinition.type !== 'agent') {
    return {
      status: 'failed',
      error: `stepType is 'agent' but stepDefinition.type is '${config.stepDefinition.type}'`,
      telemetry: { duration: 0 },
    };
  }

  const step = config.stepDefinition as AgentWorkflowStep;
  const startedAt = performance.now();

  if (signal.aborted) {
    return failedWorkerAgentResult('Workflow cancelled', startedAt);
  }

  try {
    const spawn = await spawnWorkerSubagent(handle, config, step, startedAt);
    if (spawn.status === 'failed') return spawn.result;
    return awaitWorkerSubagent(handle, step, signal, spawn.subagentId, startedAt);
  } catch (error) {
    return failedWorkerAgentResult(error instanceof Error ? error.message : String(error), startedAt);
  }
}
