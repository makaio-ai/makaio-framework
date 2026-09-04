import type { IMakaioBus } from '@makaio/bus-core';
import { WorkerSubjects, type IWorkflowRunner, type WorkerRequirements } from '@makaio/contracts';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { runAuthorityDispatchedAttempt } from './authority-dispatch-runner.js';

/**
 * Check whether requirements declare Worker-backed dispatch.
 *
 * Returns `true` when ANY meaningful constraint is defined: custom capabilities,
 * persistent storage, runtime limits, recoverable allocation, or materialization
 * mode requirements. An empty or `undefined` requirements object produces `false`.
 * @param requirements - Canonical worker requirements.
 * @returns True when at least one requirement field constrains provider selection.
 */
export function hasWorkerDispatchRequirements(requirements: WorkerRequirements | undefined): boolean {
  if (requirements === undefined) return false;
  if ((requirements.customCapabilities ?? []).length > 0) return true;
  if (requirements.persistentStorage !== undefined) return true;
  if (requirements.maxRuntimeMs !== undefined) return true;
  if (requirements.recoverableAllocation !== undefined) return true;
  if (requirements.materializationModes !== undefined && requirements.materializationModes.length > 0) return true;
  return false;
}

/**
 * Options for creating a bus-backed Worker dispatch runner.
 */
export interface WorkerDispatchRunnerOptions {
  /** Message bus used to call the generic Worker dispatch seam. */
  readonly bus: IMakaioBus;
  /** Canonical worker requirements for provider selection. */
  readonly requirements?: WorkerRequirements;
  /** Opaque metadata forwarded to the Worker dispatch request. */
  readonly dispatchMetadata?: Record<string, unknown>;
  /**
   * Execution attempt Authority for creating attempts before dispatch
   * and waiting for committed outcomes.
   */
  readonly authority: ExecutionAttemptAuthority;
}

/**
 * Create a bus-backed runner when requirements require Worker
 * provider selection.
 *
 * Custom capabilities are hard provider-selection constraints.
 * Definitions that declare them must not execute through local
 * schedulers or runners that ignore provider requirements.
 *
 * The returned runner creates an execution attempt through the
 * Authority before dispatch and waits for the committed outcome
 * via the Authority's in-process waiter. Returns
 * `authority-committed` completions.
 * @param options - Bus, requirements, optional dispatch metadata,
 *   and Authority.
 * @returns A Worker dispatch runner, or `undefined` when no
 *   capability constraint exists.
 */
export function createWorkerDispatchRunner(options: WorkerDispatchRunnerOptions): IWorkflowRunner | undefined {
  const { bus, requirements, dispatchMetadata, authority } = options;
  if (!hasWorkerDispatchRequirements(requirements)) return undefined;
  return {
    run: (config, signal) =>
      runAuthorityDispatchedAttempt({
        authority,
        executionId: config.executionId,
        dispatch: (executionAttemptId) =>
          bus.request(
            WorkerSubjects.dispatch,
            {
              executionAttemptId,
              config,
              requirements,
              ...(dispatchMetadata !== undefined ? { metadata: dispatchMetadata } : {}),
            },
            { signal },
          ),
      }),
  };
}
