import type { IMakaioBus } from '@makaio/bus-core';
import type {
  IStepRunner,
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
  /** Step runner for agent/shell execution. */
  stepRunner: IStepRunner;
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
