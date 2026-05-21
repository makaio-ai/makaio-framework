import type { ToolError, ToolFailure, ToolSuccess } from './types.js';

/**
 * Standard error codes for tool execution failures.
 * Use these codes for consistent error handling across tools.
 */
export const ToolErrorCodes = {
  /** Tool not found in registry */
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  /** Input validation failed against schema */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Tool execution not permitted */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Tool execution timed out */
  TIMEOUT: 'TIMEOUT',
  /** Tool was aborted via signal */
  ABORTED: 'ABORTED',
  /** Generic execution error */
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  /** Tool returned invalid output */
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  /** Required resource not found */
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  /** Resource limit exceeded (e.g., max concurrent shells) */
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  /** Internal tool error */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ToolErrorCode = (typeof ToolErrorCodes)[keyof typeof ToolErrorCodes];

/**
 * Error class for tool execution failures.
 * Provides structured error information and conversion to ToolError format.
 * @example
 * ```typescript
 * throw new ToolExecutionError(
 *   ToolErrorCodes.VALIDATION_FAILED,
 *   'Input path must be absolute',
 *   { path: input.path }
 * );
 * ```
 */
export class ToolExecutionError extends Error {
  /**
   * Creates a new ToolExecutionError.
   * @param code - Error code from ToolErrorCodes
   * @param message - Human-readable error message
   * @param details - Optional additional error context
   */
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }

  /**
   * Converts the error to a ToolError object for result formatting.
   * @returns ToolError suitable for ToolResult
   */
  public toToolError(): ToolError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * Creates a failed ToolResult from error parameters.
 * @param code - Error code
 * @param message - Error message
 * @param details - Optional error details
 * @returns Failed ToolResult with error information
 * @example
 * ```typescript
 * if (!fileExists) {
 *   return toolError(
 *     ToolErrorCodes.RESOURCE_NOT_FOUND,
 *     `File not found: ${path}`
 *   );
 * }
 * ```
 */
export function toolError(code: string, message: string, details?: unknown): ToolFailure {
  return {
    success: false,
    error: { code, message, details },
  };
}

/**
 * Creates a successful ToolResult with data.
 * @typeParam T - Type of the success data
 * @param data - Success data to wrap
 * @returns Successful ToolResult with data
 * @example
 * ```typescript
 * const content = await fs.readFile(path, 'utf-8');
 * return toolSuccess({ content });
 * ```
 */
export function toolSuccess<T>(data: T): ToolSuccess<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Converts an unknown error to a ToolResult.
 * Preserves ToolExecutionError details or wraps other errors.
 * @param error - Error to convert
 * @param defaultCode - Error code to use for non-ToolExecutionError
 * @returns Failed ToolResult with error information
 */
export function errorToToolResult(error: unknown, defaultCode: string = ToolErrorCodes.EXECUTION_ERROR): ToolFailure {
  if (error instanceof ToolExecutionError) {
    return {
      success: false,
      error: error.toToolError(),
    };
  }

  if (error instanceof Error) {
    return toolError(defaultCode, error.message, {
      name: error.name,
      stack: error.stack,
    });
  }

  return toolError(defaultCode, String(error));
}
