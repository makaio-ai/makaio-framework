import type { IMakaioBus } from '@makaio/bus-core';
import { WorkerNodeSubjects, type IWorkflowRunner, type WorkflowRunContext } from '@makaio/contracts';

/**
 * Create a bus-backed runner when execution hints require WorkerNode provider selection.
 *
 * Capability hints are hard provider-selection constraints. Definitions that
 * declare them must not execute through local schedulers or runners that ignore
 * provider requirements, because generated definitions may intentionally store
 * only trigger placeholders and remote execution hints.
 * @param bus - Message bus used to call the generic WorkerNode dispatch seam.
 * @param executionHints - Merged definition/request execution hints.
 * @returns A WorkerNode dispatch runner, or `undefined` when no capability constraint exists.
 */
export function createExecutionHintWorkerNodeRunner(
  bus: IMakaioBus,
  executionHints: WorkflowRunContext['executionHints'],
): IWorkflowRunner | undefined {
  const capabilities = executionHints?.requirements?.capabilities ?? [];
  if (capabilities.length === 0) return undefined;
  return {
    run: (config, signal) =>
      bus.request(
        WorkerNodeSubjects.dispatch,
        {
          config,
          requirements: { customCapabilities: capabilities },
        },
        { signal },
      ),
  };
}
