import type { ArtifactRevision, WorkflowRunResult, WorkflowWorkerConfig } from '@makaio/contracts';

/**
 * Terminal result of the runtime sequence run by the workflow orchestrator.
 */
export type RuntimeSequenceResult =
  | { readonly status: 'completed'; readonly artifact?: ArtifactRevision }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly reason?: string };

/**
 * Convert the settled execution state into the worker runner result.
 * @param config - Worker configuration carrying stable execution identifiers.
 * @param result - Settled runtime sequence result.
 * @returns Serializable workflow runner result.
 */
export function buildWorkflowRunResult(config: WorkflowWorkerConfig, result: RuntimeSequenceResult): WorkflowRunResult {
  if (result.status === 'completed') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'completed',
      ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
    };
  }
  if (result.status === 'cancelled') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'cancelled',
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }
  return {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'failed',
    error: result.error,
  };
}
