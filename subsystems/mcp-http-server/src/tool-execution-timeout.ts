/** Maximum tool-execution timeout accepted by the MCP bridge (30 minutes). */
export const MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS = 30 * 60_000;

/**
 * Validate an optional MCP tool execution timeout.
 * @param timeoutMs - Configured timeout in milliseconds.
 * @returns The validated timeout, or `undefined` to retain the bus default.
 */
export function validateToolExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS) {
    throw new RangeError(
      `toolExecutionTimeoutMs must be a positive safe integer no greater than ${MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}
