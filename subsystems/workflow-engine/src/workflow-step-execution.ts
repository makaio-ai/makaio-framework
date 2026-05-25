import type { WorkflowExpressionContext } from '@makaio/expression';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SubagentSubjects,
  JsonValueSchema,
  type AgentWorkflowStep,
  type GateWorkflowStep,
  type JsonValue,
  type PreviousStepOutput,
  type ShellWorkflowStep,
  type StepContext,
  type StepRunResult,
} from '@makaio/contracts';
import { runShellStep } from './executor-helpers.js';
import { WorkflowSubjects } from './namespace.js';
import type { LoadedWorkflow } from './workflow-orchestrator.js';
import { resolveAgentSpawnConfig } from './agent-spawn-config.js';

// ─────────────────────────────────────────────────────────────
// Function step executor
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for {@link executeFunctionStep}.
 */
export interface ExecuteFunctionStepParams {
  /** Loaded workflow providing the runtime step function map. */
  readonly loaded: LoadedWorkflow;
  /** Unique step identifier within the workflow. */
  readonly stepId: string;
  /** Fully resolved step context passed to the function. */
  readonly context: StepContext<unknown, Record<string, PreviousStepOutput<JsonValue>>>;
  /** Cancellation signal for cooperative abort. */
  readonly signal?: AbortSignal;
}

/**
 * Execute a single function-type workflow step in the worker orchestrator.
 *
 * Looks up the runtime function from `loaded.runtimeSteps`, invokes it with
 * the provided step context, and wraps the output in a {@link StepRunResult}.
 * Wall-clock duration is measured via `performance.now()`.
 * @param params - Execution parameters including the loaded workflow, step ID, and context.
 * @returns Terminal step result with status, output, and duration telemetry.
 */
export async function executeFunctionStep(params: ExecuteFunctionStepParams): Promise<StepRunResult> {
  const { loaded, stepId, context, signal } = params;

  const fn = loaded.runtimeSteps.get(stepId);
  if (!fn) {
    return {
      status: 'failed',
      error: `Runtime step not found: ${stepId}`,
      telemetry: { duration: 0 },
    };
  }

  const startedAt = performance.now();
  if (signal?.aborted) {
    return cancelledWorkerStepResult(startedAt);
  }

  const runPromise = (async (): Promise<StepRunResult> => {
    const output = await fn(context);
    const parsedOutput = JsonValueSchema.safeParse(output);
    if (!parsedOutput.success) {
      return {
        status: 'failed',
        error: `Function step output for "${stepId}" is not JSON-serializable`,
        telemetry: { duration: performance.now() - startedAt },
      };
    }
    return {
      status: 'completed',
      output: parsedOutput.data,
      telemetry: { duration: performance.now() - startedAt },
    };
  })().catch((err: unknown): StepRunResult => {
    return failedWorkerStepResult(err, startedAt);
  });

  if (!signal) {
    return runPromise;
  }

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<StepRunResult>((resolve) => {
    if (signal.aborted) {
      resolve(cancelledWorkerStepResult(startedAt));
      return;
    }
    abortListener = (): void => resolve(cancelledWorkerStepResult(startedAt));
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([runPromise, abortPromise]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

// ─────────────────────────────────────────────────────────────
// Shell step executor (worker)
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for {@link executeShellStepInWorker}.
 */
export interface ExecuteShellStepInWorkerParams {
  /** Shell workflow step definition. */
  readonly step: ShellWorkflowStep;
  /** Absolute workspace root path from `WorkflowWorkerConfig.context.repoPath`. */
  readonly workspaceRoot: string;
  /** Resolved expression context for template interpolation. */
  readonly expressionContext: WorkflowExpressionContext;
  /** Cancellation signal for cooperative abort. */
  readonly signal?: AbortSignal;
}

/**
 * Execute a shell step in the worker orchestrator.
 *
 * Delegates to {@link runShellStep} without touching any bus or execution state —
 * the caller is responsible for emitting lifecycle events.
 * @param params - Shell step execution parameters.
 * @returns Terminal step result with status, output (stdout), and duration telemetry.
 */
export async function executeShellStepInWorker(params: ExecuteShellStepInWorkerParams): Promise<StepRunResult> {
  const { step, workspaceRoot, expressionContext, signal } = params;
  const startedAt = performance.now();
  const outcome = await runShellStep({ step, workspaceRoot, expressionContext, signal });
  const duration = performance.now() - startedAt;
  if (outcome.status === 'failed') {
    return { status: 'failed', error: outcome.error, telemetry: { duration } };
  }
  return { status: 'completed', output: outcome.stdout, telemetry: { duration } };
}

/**
 * Build a failed worker step result from an unknown thrown value.
 * @param error - Unknown thrown value.
 * @param startedAt - Start timestamp from `performance.now()`.
 * @returns Failed step run result with normalized message and duration.
 */
function failedWorkerStepResult(error: unknown, startedAt: number): StepRunResult {
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    telemetry: { duration: performance.now() - startedAt },
  };
}

/**
 * Build a cancelled step result with current duration telemetry.
 * @param startedAt - Start timestamp from `performance.now()`.
 * @returns Failed step result carrying the workflow cancellation reason.
 */
function cancelledWorkerStepResult(startedAt: number): StepRunResult {
  return { status: 'failed', error: 'Workflow cancelled', telemetry: { duration: performance.now() - startedAt } };
}

/**
 * Spawn a subagent for a worker agent step after resolving role configuration.
 * @param params - Agent step execution parameters.
 * @param startedAt - Start timestamp for early failure telemetry.
 * @returns Spawned subagent ID or an early failed step result.
 */
async function spawnAgentSubagentInWorker(
  params: ExecuteAgentStepInWorkerParams,
  startedAt: number,
): Promise<{ status: 'spawned'; subagentId: string } | { status: 'failed'; result: StepRunResult }> {
  const { step, bus, coordinatorSessionId, defaultExecutionTargetId, signal, resolvedPrompt } = params;
  const agentConfig = await resolveAgentSpawnConfig(bus, step);

  if (signal?.aborted) {
    return { status: 'failed', result: cancelledWorkerStepResult(startedAt) };
  }

  const spawnResult = await bus.requestOptional(SubagentSubjects.spawn, {
    parentSessionId: coordinatorSessionId,
    config: {
      task: resolvedPrompt,
      contextMode: agentConfig.contextMode,
      adapterName: agentConfig.adapterName,
      model: agentConfig.model,
      harnessId: agentConfig.harnessId,
      systemPrompt: agentConfig.systemPrompt,
      providerContext: agentConfig.providerContext,
      executionTargetId: step.executionTargetId ?? defaultExecutionTargetId,
      responseSchema: step.outputSchema,
    },
    depth: 0,
  });

  if (!spawnResult.handled) {
    return {
      status: 'failed',
      result: {
        status: 'failed',
        error: 'Subagent system not available',
        telemetry: { duration: performance.now() - startedAt },
      },
    };
  }

  const { subagentId } = spawnResult.data;
  if (signal?.aborted) {
    await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow cancelled' }).catch(() => {});
    return { status: 'failed', result: cancelledWorkerStepResult(startedAt) };
  }

  return { status: 'spawned', subagentId };
}

// ─────────────────────────────────────────────────────────────
// Agent step executor (worker)
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for {@link executeAgentStepInWorker}.
 */
export interface ExecuteAgentStepInWorkerParams {
  /** Agent workflow step definition. */
  readonly step: AgentWorkflowStep;
  /** Worker-local bus used to send SubagentSubjects.spawn and SubagentSubjects.await RPCs. */
  readonly bus: IMakaioBus;
  /** Coordinator session ID that owns this execution. */
  readonly coordinatorSessionId: string;
  /** Optional default execution target from the workflow definition. */
  readonly defaultExecutionTargetId?: string;
  /** Cancellation signal — when aborted, kills the spawned subagent. */
  readonly signal?: AbortSignal;
  /** Timeout in milliseconds to pass to SubagentSubjects.await (optional). */
  readonly timeoutMs?: number;
  /** Resolved prompt string (template variables already substituted). */
  readonly resolvedPrompt: string;
}

/**
 * Execute an agent step in the worker orchestrator via the subagent spawn protocol.
 *
 * Sends a {@link SubagentSubjects.spawn} request, then awaits completion via
 * {@link SubagentSubjects.await}. If the spawn RPC is unhandled (subagent service
 * unavailable), the step fails immediately.
 *
 * When the `signal` is aborted while waiting, the spawned subagent is killed.
 * @param params - Agent step execution parameters.
 * @returns Terminal step result with status, output (subagent result string), and telemetry.
 */
export async function executeAgentStepInWorker(params: ExecuteAgentStepInWorkerParams): Promise<StepRunResult> {
  const { step, bus, signal, timeoutMs } = params;
  const startedAt = performance.now();

  if (signal?.aborted) {
    return cancelledWorkerStepResult(startedAt);
  }

  let subagentId: string | undefined;

  // Register an abort listener so we can kill the subagent when cancelled.
  let abortedWhileWaiting = false;
  const onAbort = (): void => {
    abortedWhileWaiting = true;
    if (subagentId !== undefined) {
      void bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow cancelled' }).catch(() => {});
    }
  };

  try {
    const spawn = await spawnAgentSubagentInWorker(params, startedAt);
    if (spawn.status === 'failed') return spawn.result;

    subagentId = spawn.subagentId;
    if (signal?.aborted) {
      await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Workflow cancelled' }).catch(() => {});
      return cancelledWorkerStepResult(startedAt);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    const awaitResult = await bus.request(SubagentSubjects.await, {
      subagentId,
      timeoutMs,
    });

    const duration = performance.now() - startedAt;

    if (abortedWhileWaiting || signal?.aborted) {
      return { status: 'failed', error: 'Workflow cancelled', telemetry: { duration } };
    }

    if (awaitResult.status !== 'completed') {
      const error = awaitResult.error ?? `Subagent ended with status: ${awaitResult.status}`;
      await bus.request(SubagentSubjects.kill, { subagentId }).catch(() => {});
      return { status: 'failed', error, telemetry: { duration } };
    }

    const output = step.onComplete?.extract === 'none' ? '' : (awaitResult.result ?? '');
    return { status: 'completed', output, telemetry: { duration } };
  } catch (error) {
    if (subagentId !== undefined) {
      await bus.request(SubagentSubjects.kill, { subagentId, reason: 'Step execution error' }).catch(() => {});
    }
    if (signal?.aborted) {
      return cancelledWorkerStepResult(startedAt);
    }
    return failedWorkerStepResult(error, startedAt);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ─────────────────────────────────────────────────────────────
// Gate step executor (worker → main process RPC)
// ─────────────────────────────────────────────────────────────

/**
 * Parameters for {@link executeGateStepInWorker}.
 */
export interface ExecuteGateStepInWorkerParams {
  /** Gate workflow step definition. */
  readonly step: GateWorkflowStep;
  /** Worker-local bus used to send the gate.awaitApproval RPC to the main process. */
  readonly bus: IMakaioBus;
  /** Execution identifier, included in the RPC payload. */
  readonly executionId: string;
  /** Workflow definition identifier, included in the RPC payload. */
  readonly workflowId: string;
  /** Workflow name, included in the RPC payload for display purposes. */
  readonly workflowName: string;
  /** Resolved gate prompt string (template variables already substituted). */
  readonly resolvedPrompt: string;
  /** Resolved gate title (template variables already substituted). */
  readonly resolvedTitle: string;
  /** Cancellation signal for cooperative abort while awaiting approval. */
  readonly signal?: AbortSignal;
}

/**
 * Execute a gate step in the worker orchestrator by sending a
 * {@link WorkflowSubjects.gate.awaitApproval} RPC to the main-process executor.
 *
 * The main-process handler registers the pending resolution promise, emits
 * `gate.requested`, and awaits the user's `gate.respond` response — ensuring
 * the race-safe ordering is handled centrally.
 * @param params - Gate step execution parameters.
 * @returns Terminal step result with status and telemetry.
 */
export async function executeGateStepInWorker(params: ExecuteGateStepInWorkerParams): Promise<StepRunResult> {
  const { step, bus, executionId, workflowId, workflowName, resolvedPrompt, resolvedTitle, signal } = params;
  const startedAt = performance.now();

  if (signal?.aborted) {
    return { status: 'failed', error: 'Workflow cancelled', telemetry: { duration: performance.now() - startedAt } };
  }

  let abortCleanup: (() => void) | undefined;

  try {
    const approvalPromise = bus.request(WorkflowSubjects.gate.awaitApproval, {
      executionId,
      stepId: step.id,
      stepType: 'gate',
      workflowId,
      workflowName,
      title: resolvedTitle,
      message: resolvedPrompt,
      autoAction: step.autoAction,
      timeoutMs: typeof step.timeoutMs === 'number' ? step.timeoutMs : null,
      openedAt: Date.now(),
    });

    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        void bus
          .request(WorkflowSubjects.gate.respond, {
            executionId,
            stepId: step.id,
            action: 'reject',
            reason: 'Workflow cancelled',
          })
          .catch(() => {});
        reject(new Error('Workflow cancelled'));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal?.removeEventListener('abort', onAbort);
    });

    const resolution = await Promise.race([approvalPromise, abortPromise]);
    const duration = performance.now() - startedAt;

    if (resolution.action === 'approve') {
      const output = resolution.source === 'user' ? 'Approved by user' : 'Auto-approved (timeout)';
      return { status: 'completed', output, telemetry: { duration } };
    }

    const error = resolution.source === 'user' ? 'Rejected by user' : 'Auto-rejected (timeout)';
    return { status: 'failed', error, telemetry: { duration } };
  } catch (error) {
    return failedWorkerStepResult(error, startedAt);
  } finally {
    abortCleanup?.();
  }
}
