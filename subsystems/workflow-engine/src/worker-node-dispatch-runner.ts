import type { IMakaioBus } from '@makaio/bus-core';
import { WorkerNodeSubjects, type IWorkflowRunner, type WorkerNodeRequirements } from '@makaio/contracts';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { runAuthorityDispatchedAttempt } from './authority-dispatch-runner.js';

/**
 * Check whether requirements declare WorkerNode-backed dispatch.
 *
 * Returns `true` when ANY meaningful constraint is defined: custom capabilities,
 * persistent storage, runtime limits, recoverable allocation, or materialization
 * mode requirements. An empty or `undefined` requirements object produces `false`.
 * @param requirements - Canonical worker-node requirements.
 * @returns True when at least one requirement field constrains provider selection.
 */
export function hasWorkerNodeDispatchRequirements(requirements: WorkerNodeRequirements | undefined): boolean {
  if (requirements === undefined) return false;
  if ((requirements.customCapabilities ?? []).length > 0) return true;
  if (requirements.persistentStorage !== undefined) return true;
  if (requirements.maxRuntimeMs !== undefined) return true;
  if (requirements.recoverableAllocation !== undefined) return true;
  if (requirements.materializationModes !== undefined && requirements.materializationModes.length > 0) return true;
  return false;
}

/**
 * Options for creating a bus-backed WorkerNode dispatch runner.
 */
export interface WorkerNodeDispatchRunnerOptions {
  /** Message bus used to call the generic WorkerNode dispatch seam. */
  readonly bus: IMakaioBus;
  /** Canonical worker-node requirements for provider selection. */
  readonly requirements?: WorkerNodeRequirements;
  /** Opaque metadata forwarded to the WorkerNode dispatch request. */
  readonly dispatchMetadata?: Record<string, unknown>;
  /**
   * Execution attempt Authority for creating attempts before dispatch
   * and waiting for committed outcomes.
   */
  readonly authority: ExecutionAttemptAuthority;
}

/**
 * Create a bus-backed runner when requirements require WorkerNode
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
 * @returns A WorkerNode dispatch runner, or `undefined` when no
 *   capability constraint exists.
 */
export function createWorkerNodeDispatchRunner(options: WorkerNodeDispatchRunnerOptions): IWorkflowRunner | undefined {
  const { bus, requirements, dispatchMetadata, authority } = options;
  if (!hasWorkerNodeDispatchRequirements(requirements)) return undefined;
  return {
    run: (config, signal) =>
      runAuthorityDispatchedAttempt({
        authority,
        executionId: config.executionId,
        dispatch: (executionAttemptId) =>
          bus.request(
            WorkerNodeSubjects.dispatch,
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
