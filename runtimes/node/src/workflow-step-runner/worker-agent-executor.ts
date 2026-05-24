import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  WorkflowSubjects,
  type AgentWorkflowStep,
  type ProviderContext,
  type StepRunConfig,
  type StepRunResult,
} from '@makaio/contracts';
import { resolveTemplate, type ExpressionContext } from '@makaio/expression';
import { bootWorkerRuntime, type WorkerBusHandle, type WorkerRuntimeHandle } from './worker-boot.js';
import type { WorkerContributions } from './worker-contributions.js';

/**
 * Configuration resolved from either a named role or inline step fields.
 *
 * Contains the adapter name, optional model, and other overrides needed
 * to construct an `adapter.startAgent` request.
 */
interface ResolvedAgentConfig {
  /** Adapter name for routing the startAgent RPC. */
  adapterName: string;
  /** Model identifier override. */
  model?: string;
  /** Harness ID for per-role tool governance. */
  harnessId?: string;
  /** System prompt to prepend for this role. */
  systemPrompt?: string;
  /** Provider context for credential resolution. */
  providerContext?: ProviderContext;
}

/**
 * Resolve the agent configuration for a workflow step.
 *
 * When the step specifies a `role`, issues an RPC to `workflow.resolveRole`
 * to obtain the full adapter configuration. Otherwise extracts the adapter
 * name and model directly from the step definition fields.
 * @param bus - Bus instance for RPC calls.
 * @param step - Agent workflow step definition.
 * @returns Resolved adapter configuration.
 * @throws When `role` resolution fails or neither `role` nor `adapter` is specified.
 */
async function resolveAgentConfig(bus: IMakaioBus, step: AgentWorkflowStep): Promise<ResolvedAgentConfig> {
  if (step.role) {
    const resolved = await bus.request(WorkflowSubjects.resolveRole, { roleId: step.role });
    return {
      adapterName: resolved.adapterName,
      model: resolved.model,
      harnessId: resolved.harnessId,
      systemPrompt: resolved.systemPrompt,
      providerContext: resolved.providerContext,
    };
  }

  if (!step.adapter) {
    throw new Error('Agent step must specify either "role" or "adapter"');
  }

  return {
    adapterName: step.adapter,
    model: step.model,
    harnessId: step.harnessId,
  };
}

/**
 * Wait for an agent to emit its completion event on the bus.
 *
 * Subscribes to `agent.complete` filtered by the agent ID and waits for
 * the first completion event. Respects the provided abort signal for
 * cooperative cancellation.
 * @param bus - Bus instance to listen on.
 * @param agentId - Agent ID to filter for.
 * @param signal - Abort signal for cancellation.
 * @returns The agent's output message, or an empty string if none.
 * @throws When the signal is aborted before agent completion.
 */
async function awaitAgentCompletion(
  bus: IMakaioBus,
  agentId: string,
  signal: AbortSignal,
): Promise<{ output: string; error?: string }> {
  const ctx = await bus.once(AgentSubjects.complete, {
    filter: { agentId },
    signal,
  });

  const outcome = ctx.payload.outcome ?? 'completed';
  if (outcome === 'error') {
    return { output: '', error: ctx.payload.error ?? 'Agent completed with error' };
  }

  return { output: ctx.payload.message ?? '' };
}

/**
 * Close worker-local runtime resources without changing the step result shape.
 * @param runtime - Worker runtime handle to close.
 */
async function closeWorkerRuntime(runtime: WorkerRuntimeHandle | undefined): Promise<void> {
  if (!runtime) return;

  await runtime.close();
}

/**
 * Check whether a value is a plain record for expression context fields.
 * @param value - Candidate value.
 * @returns True when the value can be indexed safely.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check whether a value matches the step map shape used by expression templates.
 * @param value - Candidate `steps` field from StepRunConfig.resolvedInputs.
 * @returns True when every entry exposes a string `status`.
 */
function isExpressionSteps(value: unknown): value is ExpressionContext['steps'] {
  if (!isRecord(value)) return false;

  for (const stepState of Object.values(value)) {
    if (!isRecord(stepState) || typeof stepState['status'] !== 'string') return false;
    if ('result' in stepState && stepState['result'] !== undefined && typeof stepState['result'] !== 'string') {
      return false;
    }
  }
  return true;
}

/**
 * Rehydrate the scheduler-built expression context from the serializable runner config.
 * @param resolvedInputs - StepRunConfig context payload.
 * @returns Expression context for prompt interpolation.
 */
function buildWorkerExpressionContext(resolvedInputs: StepRunConfig['resolvedInputs']): ExpressionContext {
  const context: ExpressionContext = {
    trigger: isRecord(resolvedInputs['trigger']) ? resolvedInputs['trigger'] : {},
    steps: isExpressionSteps(resolvedInputs['steps']) ? resolvedInputs['steps'] : {},
    inputs: isRecord(resolvedInputs['inputs']) ? resolvedInputs['inputs'] : {},
  };

  if ('item' in resolvedInputs) {
    context.item = resolvedInputs['item'];
  }
  if (typeof resolvedInputs['index'] === 'number') {
    context.index = resolvedInputs['index'];
  }

  return context;
}

/**
 * Execute an agent workflow step inside the worker process.
 *
 * Resolves the step's adapter configuration (via role or inline fields),
 * starts the agent locally via the `adapter.startAgent` bus RPC, waits
 * for the agent to complete, and returns a {@link StepRunResult}.
 *
 * This function runs the adapter directly in-process rather than delegating
 * to the subagent orchestration layer. The adapter must be available on the
 * worker's local bus (loaded via worker contributions).
 * @param handle - Worker bus handle with an active bus instance.
 * @param config - Step run configuration describing the agent step.
 * @param signal - Abort signal for cooperative cancellation.
 * @param contributions - Optional worker contributions providing adapter and toolset definitions.
 * @returns Step run result with the agent's output and telemetry.
 */
export async function runWorkerAgentStep(
  handle: WorkerBusHandle,
  config: StepRunConfig,
  signal: AbortSignal,
  contributions?: WorkerContributions,
): Promise<StepRunResult> {
  const startTime = performance.now();
  let runtime: WorkerRuntimeHandle | undefined;

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
  const { bus } = handle;

  try {
    if (contributions) {
      runtime = await bootWorkerRuntime(handle, contributions, config.platformDefaults);
    }

    const agentConfig = await resolveAgentConfig(bus, step);
    const resolvedPrompt = resolveTemplate(step.prompt, buildWorkerExpressionContext(config.resolvedInputs));

    const startResult = await bus.request(AdapterSubjects.startAgent, {
      adapterId: agentConfig.adapterName,
      role: 'member',
      model: agentConfig.model,
      harnessId: agentConfig.harnessId,
      providerContext: agentConfig.providerContext,
      initialMessage: resolvedPrompt,
      env: config.platformDefaults.env,
    });

    if (!startResult.success) {
      const duration = performance.now() - startTime;
      return {
        status: 'failed',
        error: startResult.message,
        telemetry: { duration },
      };
    }

    const { agentId } = startResult;

    const completion = await awaitAgentCompletion(bus, agentId, signal);
    const duration = performance.now() - startTime;

    if (completion.error) {
      return {
        status: 'failed',
        error: completion.error,
        telemetry: { duration },
      };
    }

    return {
      status: 'completed',
      output: completion.output,
      telemetry: { duration },
    };
  } catch (error: unknown) {
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      status: 'failed',
      error: errorMessage,
      telemetry: { duration },
    };
  } finally {
    await closeWorkerRuntime(runtime);
  }
}
