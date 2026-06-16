/**
 * Workflow error codes for programmatic handling by hosts and extensions.
 */
export const WorkflowErrorCode = {
  RUN_CONTEXT_NOT_FOUND: 'WORKFLOW_RUN_CONTEXT_NOT_FOUND',
  SNAPSHOT_UNAVAILABLE: 'WORKFLOW_SNAPSHOT_UNAVAILABLE',
  SOURCE_MISMATCH: 'WORKFLOW_SOURCE_MISMATCH',
  NOT_EXECUTABLE: 'WORKFLOW_NOT_EXECUTABLE',
  HANDLER_UNAVAILABLE: 'WORKFLOW_HANDLER_UNAVAILABLE',
} as const;

export type WorkflowErrorCode = (typeof WorkflowErrorCode)[keyof typeof WorkflowErrorCode];

/**
 * Typed workflow error with a stable machine-readable code.
 */
export class WorkflowError extends Error {
  /**
   * @param code - Machine-readable error code from {@link WorkflowErrorCode}.
   * @param message - Human-readable error description.
   */
  public constructor(
    public readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
