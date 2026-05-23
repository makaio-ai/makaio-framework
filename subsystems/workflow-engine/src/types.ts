import type { WorkflowDefinition, WorkflowExecution, WorkflowStep } from '@makaio/contracts';
import type { ForEachStepContext } from './for-each-expander.js';

/**
 * Configuration for the workflow executor.
 */
export interface ExecutorConfig {
  /** Timeout for individual step execution in ms. */
  stepTimeoutMs: number;
  /** Cooldown between steps in ms. */
  stepCooldownMs: number;
}

/**
 * Default executor configuration.
 */
export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  stepTimeoutMs: 5 * 60 * 1000, // 5 minutes
  stepCooldownMs: 500,
};

/**
 * Active execution state tracked by the executor.
 */
export interface ActiveExecution {
  /** The execution state. */
  execution: WorkflowExecution;
  /** The workflow definition being executed. */
  workflow: WorkflowDefinition;
  /** Flat step array after for-each expansion. All executor logic uses this. */
  expandedSteps: WorkflowStep[];
  /** O(1) step lookup cache keyed by expanded step ID. */
  stepMap: Map<string, WorkflowStep>;
  /** Per-step context overrides for for-each item/index scoping. */
  stepContext: Map<string, ForEachStepContext>;
}
