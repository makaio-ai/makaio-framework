/**
 * Subagent error codes for programmatic handling.
 */
export const SubagentErrorCode = {
  NOT_FOUND: 'SUBAGENT_NOT_FOUND',
  DEPTH_EXCEEDED: 'DEPTH_EXCEEDED',
  SESSION_LIMIT: 'SESSION_LIMIT',
  GLOBAL_LIMIT: 'GLOBAL_LIMIT',
  ADAPTER_NOT_ALLOWED: 'ADAPTER_NOT_ALLOWED',
  MODEL_NOT_ALLOWED: 'MODEL_NOT_ALLOWED',
  ADAPTER_START_FAILED: 'ADAPTER_START_FAILED',
  ALREADY_TERMINAL: 'ALREADY_TERMINAL',
  REQUEST_PENDING: 'REQUEST_PENDING',
  INVALID_STATE: 'INVALID_STATE',
} as const;

export type SubagentErrorCode = (typeof SubagentErrorCode)[keyof typeof SubagentErrorCode];

/**
 * Typed error for subagent operations.
 */
export class SubagentError extends Error {
  public constructor(
    public readonly code: SubagentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubagentError';
  }
}
