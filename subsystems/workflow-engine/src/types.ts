import type { IMakaioBus } from '@makaio/bus-core';
import type {
  StepRunConfig,
  StepRunResult,
  StepRunnerBusAuth,
  StepRunnerPlatformDefaults,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
} from '@makaio/contracts';
import type { ForEachStepContext } from './for-each-expander.js';
import type { WorkflowGateCoordinator } from './workflow-gate-coordinator.js';

/**
 * Tracks an active runner-managed step for cooperative/hard cancellation.
 * Stored in the `activeRunnerSteps` map keyed by `{executionId}:{stepId}`.
 */
export interface ActiveRunnerStep {
  /** AbortController whose signal is passed to the runner for cooperative cancellation. */
  controller: AbortController;
  /** Per-step bus subject emitted so remote workers can observe cancellation. */
  cancelSubject: string;
  /** Timer that fires forceKill after the cancel grace period expires. */
  hardKillTimer?: ReturnType<typeof setTimeout>;
}

/**
 * A single node in the scheduler DAG.
 * Shared between the live scheduler and the graph rebuild utility.
 */
export interface SchedulerNode {
  /** The workflow step definition (may be composite or executable). */
  step: WorkflowStep;
  /** Step IDs that must reach a terminal state before this node can start. */
  needs: Set<string>;
  /** Step IDs that depend on this node. */
  dependents: Set<string>;
}

/**
 * Read-only representation of a rebuilt scheduler graph.
 */
export interface SchedulerGraph {
  /** Scheduler nodes keyed by workflow step ID. */
  readonly nodes: ReadonlyMap<
    string,
    { step: WorkflowStep; needs: ReadonlySet<string>; dependents: ReadonlySet<string> }
  >;
  /** Persisted item/index context keyed by expanded child step ID. */
  readonly stepContext: ReadonlyMap<string, ForEachStepContext>;
}

/**
 * Deps injected into the scheduler by the executor.
 */
export interface WorkflowSchedulerDeps {
  /** Message bus for storage writes and lifecycle events. */
  bus: IMakaioBus;
  /** Active execution registry shared with the executor. */
  activeExecutions: Map<string, ActiveExecution>;
  /** Shell process abort controllers keyed by `{executionId}:{stepId}`. */
  shellAbortControllers: Map<string, AbortController>;
  /** Active runner step entries keyed by `{executionId}:{stepId}` for cancellation tracking. */
  activeRunnerSteps: Map<string, ActiveRunnerStep>;
  /** Gate coordinator for approval/reject flows. */
  gateCoordinator: WorkflowGateCoordinator;
  /**
   * Execute a workflow step.
   * Replaces the `IStepRunner.run()` method so the scheduler is not coupled to
   * the step runner implementation and can be reused in the worker orchestrator.
   * @param config - Step run configuration.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Step run result with functional output and telemetry.
   */
  runStep: (config: StepRunConfig, signal: AbortSignal) => Promise<StepRunResult>;
  /**
   * Force-kill an in-flight step after the cooperative cancellation grace period.
   * Replaces the optional `IStepRunner.forceKill()` method.
   * When omitted (worker context), hard-kill is not available.
   * @param executionId - Execution ID owning the step.
   * @param stepId - Identifier of the step to kill.
   */
  forceKillStep?: (executionId: string, stepId: string) => void | Promise<void>;
  /**
   * Whether the underlying runner manages full workflow lifecycle events
   * (bus subscriptions, session creation, etc.).
   * Replaces `IStepRunner.managesWorkflowLifecycle`.
   *
   * - `true`: Runner owns session lifecycle; orchestrator skips pre-step setup.
   * - `false`: Orchestrator emits `step.started` and persists initial step state.
   */
  runnerManagesLifecycle: boolean;
  /**
   * Called when an in-flight step with an active subagent is aborted.
   * Replaces the inline `SubagentSubjects.kill` bus RPC in abort handling so the
   * scheduler does not depend on the subagent bus subject.
   * When omitted, subagent kill is skipped (worker context or test harness).
   * @param nodeId - Scheduler node ID of the aborting step.
   * @param subagentId - Subagent identifier to kill.
   */
  onAbortSubagent?: (nodeId: string, subagentId: string) => Promise<void>;
  /**
   * Execute a `function`-type workflow step inline (worker context only).
   *
   * Function steps run the authored JavaScript function directly in the worker
   * process — they are not dispatched through a {@link StepRunConfig} because
   * their step definition is not serializable across process boundaries.
   *
   * When omitted the scheduler fails function steps immediately, which is the
   * correct behaviour in the main-process executor where function steps are
   * not supported.
   * @param executionId - Execution ID owning the step.
   * @param stepId - Step identifier to execute.
   * @param resolvedInputs - Expression context resolved from prior step outputs.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Terminal step run result.
   */
  runFunctionStep?: (
    executionId: string,
    stepId: string,
    resolvedInputs: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<StepRunResult>;
  /**
   * Execute a `gate`-type workflow step (worker context only).
   *
   * In the main-process executor, gate steps are handled directly by the
   * scheduler via the local {@link WorkflowGateCoordinator}. In the worker
   * context, the coordinator cannot receive `gate.respond` events routed
   * through the main-process bus, so gate steps must be forwarded to the main
   * process via the `gate.awaitApproval` bus RPC instead.
   *
   * When provided, the scheduler calls this instead of the built-in
   * `executeGateStep` from step-executors. The step lifecycle (state
   * initialisation, persistence, events) is still managed by the scheduler.
   * When omitted, the scheduler uses `executeGateStep` with the injected
   * gate coordinator.
   * @param executionId - Execution ID owning the step.
   * @param stepId - Step identifier to execute.
   * @param resolvedInputs - Expression context resolved from prior step outputs.
   * @param signal - AbortSignal for cooperative cancellation.
   * @returns Terminal step run result.
   */
  runGateStep?: (
    executionId: string,
    stepId: string,
    resolvedInputs: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<StepRunResult>;
  /** Executor config (timeouts, cooldowns). */
  config: ExecutorConfig;
}

/**
 * Configuration for the workflow executor.
 */
export interface ExecutorConfig {
  /** Timeout for individual step execution in ms. */
  stepTimeoutMs: number;
  /** Cooldown between steps in ms. */
  stepCooldownMs: number;
  /** Bus server WebSocket URL for runner worker connections. */
  busUrl?: string;
  /** Bus authentication strategy for runner worker connections. */
  busAuth: StepRunnerBusAuth;
  /** Platform-level defaults (cwd, env) for runner process creation. */
  platformDefaults: StepRunnerPlatformDefaults;
  /** Grace period in ms before forceKill is issued after cooperative abort. */
  cancelTimeoutMs: number;
  /**
   * Absolute path to the Makaio data-home directory.
   *
   * Forwarded to workflow workers as `context.makaioHome` so workers can
   * locate stored config, keys, and installed extensions. When omitted the
   * executor derives a default from the `MAKAIO_HOME` environment variable
   * or `~/.makaio`.
   */
  makaioHome?: string;
}

/**
 * Default executor configuration.
 */
export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  stepTimeoutMs: 5 * 60 * 1000, // 5 minutes
  stepCooldownMs: 500,
  busAuth: { kind: 'none' },
  platformDefaults: { cwd: process.cwd() },
  cancelTimeoutMs: 10_000,
};

/**
 * Active execution state tracked by the executor.
 *
 * The scheduler maintains `stepMap` and `stepContext` as mutable registries:
 * authored composite (for-each) steps are present at start, and child steps
 * are inserted as each for-each node is expanded at runtime.
 */
export interface ActiveExecution {
  /** The execution state. */
  execution: WorkflowExecution;
  /** The workflow definition being executed. */
  workflow: WorkflowDefinition;
  /**
   * O(1) step lookup cache keyed by step ID.
   * Seeded with authored steps at execution start; child steps are added as
   * for-each composite nodes are expanded by the scheduler.
   */
  stepMap: Map<string, WorkflowStep>;
  /** Per-step context overrides for for-each item/index scoping. */
  stepContext: Map<string, ForEachStepContext>;
}
