import type {
  StationHandler,
  StepRunnerBusAuth,
  StepRunnerPlatformDefaults,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowRunContext,
} from '@makaio/contracts';

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
 * Holds the live execution record, the workflow definition, and the station
 * handler map for handler-bearing executions (e.g. inline builds, runFile).
 */
export interface ActiveExecution {
  /** The execution state. */
  execution: WorkflowExecution;
  /** The workflow definition being executed. */
  workflow: WorkflowDefinition;
  /** Durable run-context snapshot used to populate runtime station context. */
  runContext: WorkflowRunContext;
  /**
   * Station handler functions keyed by node ID.
   * Populated at execution start for handler-bearing executions
   * (e.g. inline builds, runFile). Empty for definition-backed executions.
   */
  runtimeHandlers: Map<string, StationHandler>;
}
