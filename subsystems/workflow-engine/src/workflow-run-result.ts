import type { ArtifactRevision, WorkflowRunResult, WorkflowWorkerConfig } from '@makaio/contracts';

/**
 * Result type of the runtime sequence run by the workflow orchestrator.
 *
 * Discriminated on `status` so callers can access gate identity fields without
 * runtime guards after narrowing to `'paused'`.
 */
export type RuntimeSequenceResult =
  | { readonly status: 'completed'; readonly artifact?: ArtifactRevision }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly reason?: string }
  | {
      readonly status: 'paused';
      /** Node ID of the gate at which execution was suspended. */
      readonly pausedAtGateId: string;
      /** Frame ID of the suspended gate instance. */
      readonly pausedAtFrameId: string;
    };

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
  if (result.status === 'paused') {
    return {
      executionId: config.executionId,
      workflowId: config.workflowId,
      status: 'paused',
      pausedAtGateId: result.pausedAtGateId,
      pausedAtFrameId: result.pausedAtFrameId,
    };
  }
  return {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'failed',
    error: result.error,
  };
}
