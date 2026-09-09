import type { IMakaioBus } from '@makaio/bus-core';
import { randomUUID } from 'node:crypto';
import { WorkerSubjects, type IWorkflowRunner, type WorkerRequirements } from '@makaio/contracts';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { runAuthorityDispatchedAttempt } from './authority-dispatch-runner.js';
import { buildWorkflowAttemptInstruction } from './workflow-attempt-instruction.js';
import { toCommittedWorkflowRunnerResult, type WorkflowAttemptOutcome } from './workflow-attempt-outcome.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';

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
  readonly authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
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
    terminalAuthority: 'authority',
    run: async (config, signal, manifest, runOptions) => {
      signal.throwIfAborted();
      const runContext =
        config.source.kind === 'path'
          ? (await bus.request(WorkflowStorageSubjects.getRunContext, { executionId: config.executionId }, { signal }))
              .runContext
          : undefined;
      signal.throwIfAborted();
      const instruction = buildWorkflowAttemptInstruction({
        id: randomUUID(),
        revision: '1',
        config,
        ...(runContext != null ? { runContext } : {}),
        preservation: { required: [] },
      });
      // The runner contract owes a completion wrapper; the generic dispatch
      // path yields the committed outcome itself.
      const result = await runAuthorityDispatchedAttempt({
        authority,
        executionId: config.executionId,
        instruction,
        withAttemptCreation: runOptions?.withAttemptCreation,
        dispatch: (executionAttemptId) =>
          bus.request(
            WorkerSubjects.dispatch,
            {
              executionAttemptId,
              config: { ...config, terminalAuthority: 'authority' },
              requirements,
              ...(manifest !== undefined ? { manifest } : {}),
              ...(dispatchMetadata !== undefined || runOptions?.dispatchMetadata !== undefined
                ? { metadata: { ...dispatchMetadata, ...runOptions?.dispatchMetadata } }
                : {}),
            },
            { signal },
          ),
      });
      return { state: 'authority-committed', result: toCommittedWorkflowRunnerResult(result, config) };
    },
  };
}
