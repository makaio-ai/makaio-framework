import type { IWorkflowRunner, WorkerRequirements } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';

/** Inputs available when selecting the runner for a stored definition. */
export interface WorkflowRunnerSelectionInput {
  /** Identifier of the execution to run. */
  readonly executionId: string;
  /** Worker requirements declared by the definition, if any. */
  readonly requirements: WorkerRequirements | undefined;
}

/**
 * Select a runner for a definition before persisting the execution.
 * @param call - Context of the request that starts the definition.
 * @param input - Execution identity and declared worker requirements.
 * @returns The selected runner, or undefined to use the configured fallback.
 */
export type WorkflowRunnerSelector = (
  call: CallContext,
  input: WorkflowRunnerSelectionInput,
) => IWorkflowRunner | undefined;

/**
 * Record cancellation intent before the execution lifecycle changes.
 * @param call - Context of the request that cancels the execution.
 * @param executionId - Execution being cancelled.
 * @param reason - Optional reason supplied by the caller.
 */
export type RunCancellationHook = (call: CallContext, executionId: string, reason?: string) => Promise<void>;
