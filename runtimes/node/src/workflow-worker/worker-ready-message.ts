/** Message type posted by workflow workers once bus control routing is ready. */
export const WORKFLOW_WORKER_READY_MESSAGE_TYPE = 'makaio.workflow-worker.ready' as const;

/** Piscina worker-to-pool message emitted after cancel routing is subscribed. */
export interface WorkflowWorkerReadyMessage {
  /** Stable message discriminator. */
  readonly type: typeof WORKFLOW_WORKER_READY_MESSAGE_TYPE;
  /** Workflow execution whose worker is ready. */
  readonly executionId: string;
  /** Dynamic workflow cancel subject observed by the worker. */
  readonly cancelSubject: string;
  /** Adapter identifiers loaded in the worker runtime before readiness. */
  readonly adapters: readonly string[];
}

/**
 * Build a workflow-worker ready message.
 * @param executionId - Workflow execution whose worker is ready.
 * @param cancelSubject - Dynamic cancel subject observed by the worker.
 * @param adapters - Adapter identifiers loaded in the worker runtime.
 * @returns Ready message posted from the worker thread to the Piscina pool.
 */
export function createWorkflowWorkerReadyMessage(
  executionId: string,
  cancelSubject: string,
  adapters: readonly string[] = [],
): WorkflowWorkerReadyMessage {
  return {
    type: WORKFLOW_WORKER_READY_MESSAGE_TYPE,
    executionId,
    cancelSubject,
    adapters,
  };
}

/**
 * Check whether an arbitrary Piscina message is a workflow-worker ready signal.
 * @param message - Message emitted by a Piscina worker.
 * @returns True when the message has the workflow-worker ready shape.
 */
export function isWorkflowWorkerReadyMessage(message: unknown): message is WorkflowWorkerReadyMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === WORKFLOW_WORKER_READY_MESSAGE_TYPE &&
    typeof candidate.executionId === 'string' &&
    typeof candidate.cancelSubject === 'string' &&
    Array.isArray(candidate.adapters) &&
    candidate.adapters.every((adapter) => typeof adapter === 'string')
  );
}
