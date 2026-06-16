import type { IMakaioBus } from '@makaio/bus-core';
import { WorkerNodeSubjects, type IWorkflowRunner, type WorkflowRunContext } from '@makaio/contracts';

/**
 * Check whether execution hints require WorkerNode-backed dispatch.
 * @param executionHints - Merged definition/request execution hints.
 * @returns True when WorkerNode capabilities are declared.
 */
export function hasExecutionHintWorkerNodeDispatch(executionHints: WorkflowRunContext['executionHints']): boolean {
  return (executionHints?.requirements?.capabilities ?? []).length > 0;
}

/**
 * Create a bus-backed runner when execution hints require WorkerNode provider selection.
 *
 * Capability hints are hard provider-selection constraints. Definitions that
 * declare them must not execute through local schedulers or runners that ignore
 * provider requirements, because generated definitions may intentionally store
 * only trigger placeholders and remote execution hints.
 * @param bus - Message bus used to call the generic WorkerNode dispatch seam.
 * @param executionHints - Merged definition/request execution hints.
 * @param dispatchMetadata - Opaque metadata forwarded to the WorkerNode dispatch request.
 * @returns A WorkerNode dispatch runner, or `undefined` when no capability constraint exists.
 */
export function createExecutionHintWorkerNodeRunner(
  bus: IMakaioBus,
  executionHints: WorkflowRunContext['executionHints'],
  dispatchMetadata?: Record<string, unknown>,
): IWorkflowRunner | undefined {
  const capabilities = executionHints?.requirements?.capabilities ?? [];
  if (!hasExecutionHintWorkerNodeDispatch(executionHints)) return undefined;
  return {
    run: (config, signal) =>
      bus.request(
        WorkerNodeSubjects.dispatch,
        {
          config,
          requirements: { customCapabilities: capabilities },
          ...(dispatchMetadata !== undefined ? { metadata: dispatchMetadata } : {}),
        },
        { signal },
      ),
  };
}
