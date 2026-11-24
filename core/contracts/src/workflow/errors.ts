/**
 * Workflow error codes for programmatic handling by hosts and extensions.
 */
export const WorkflowErrorCode = {
  RUN_CONTEXT_NOT_FOUND: 'WORKFLOW_RUN_CONTEXT_NOT_FOUND',
  DEFINITION_NOT_FOUND: 'WORKFLOW_DEFINITION_NOT_FOUND',
  SNAPSHOT_UNAVAILABLE: 'WORKFLOW_SNAPSHOT_UNAVAILABLE',
  SOURCE_MISMATCH: 'WORKFLOW_SOURCE_MISMATCH',
  NOT_EXECUTABLE: 'WORKFLOW_NOT_EXECUTABLE',
  HANDLER_UNAVAILABLE: 'WORKFLOW_HANDLER_UNAVAILABLE',
  DEFINITION_INVALID: 'WORKFLOW_DEFINITION_INVALID',
  AGENT_STEP_UNSUPPORTED: 'WORKFLOW_AGENT_STEP_UNSUPPORTED',
  LOOP_CHECK_MULTIPLE: 'WORKFLOW_LOOP_CHECK_MULTIPLE',
  STEP_OUTPUT_SCHEMA_INVALID: 'WORKFLOW_STEP_OUTPUT_SCHEMA_INVALID',
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

/**
 * Detects the {@link WorkflowErrorCode.DEFINITION_INVALID} case across direct,
 * bus-wrapped, and transport-deserialized errors.
 *
 * A request handler throws a {@link WorkflowError} with this code; the bus may
 * wrap it as `cause` on a `RequestError` before it reaches the caller in the
 * same process. Across a transport boundary, `serializeError` lifts the code
 * from the `cause` onto the top-level error, and `deserializeTransportError`
 * restores it as an own `code` property — so neither the original error class
 * nor its `cause` chain survives, only the `code`. This predicate therefore
 * checks all three shapes and never compares message text.
 * @param error - Error thrown or received by a caller, in any of the shapes above
 * @returns True when the error represents an invalid stored workflow definition
 */
export function isDefinitionInvalidError(error: unknown): error is Error {
  if (error instanceof WorkflowError) {
    return error.code === WorkflowErrorCode.DEFINITION_INVALID;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.cause instanceof WorkflowError) {
    return error.cause.code === WorkflowErrorCode.DEFINITION_INVALID;
  }
  return 'code' in error && error.code === WorkflowErrorCode.DEFINITION_INVALID;
}
