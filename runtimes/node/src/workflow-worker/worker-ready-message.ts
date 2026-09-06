/** Message type posted by workflow workers once the authority accepted the runtime. */
export const WORKFLOW_WORKER_READY_MESSAGE_TYPE = 'makaio.workflow-worker.ready' as const;

/**
 * Piscina worker-to-pool message emitted after the attempt accepted this runtime.
 *
 * The message is posted only by the attempt-bound arm of the worker entrypoint,
 * after `execution-attempt.runtime.register` returned and the workflow run
 * passed the attempt's start gate. It therefore means "the authority accepted
 * this runtime", not "the worker finished composing itself".
 */
export interface WorkflowWorkerReadyMessage {
  /** Stable message discriminator. */
  readonly type: typeof WORKFLOW_WORKER_READY_MESSAGE_TYPE;
  /** Workflow execution whose worker is ready. */
  readonly executionId: string;
  /** Dynamic workflow cancel subject observed by the worker. */
  readonly cancelSubject: string;
  /** Attempt whose runtime registration the authority accepted. */
  readonly executionAttemptId: string;
}

/**
 * Build a workflow-worker ready message.
 * @param executionId - Workflow execution whose worker is ready.
 * @param cancelSubject - Dynamic cancel subject observed by the worker.
 * @param executionAttemptId - Attempt whose runtime registration was accepted.
 * @returns Ready message posted from the worker thread to the Piscina pool.
 */
export function createWorkflowWorkerReadyMessage(
  executionId: string,
  cancelSubject: string,
  executionAttemptId: string,
): WorkflowWorkerReadyMessage {
  return {
    type: WORKFLOW_WORKER_READY_MESSAGE_TYPE,
    executionId,
    cancelSubject,
    executionAttemptId,
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
    typeof candidate.executionAttemptId === 'string'
  );
}
