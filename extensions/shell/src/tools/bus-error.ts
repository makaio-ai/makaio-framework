import { toolError, ToolErrorCodes, type ToolFailure } from '@makaio/tools-core';

/**
 * Known error codes embedded by the shell service in thrown error messages.
 * Format used by ShellService: `${CODE}: human message`.
 */
const EMBEDDED_CODES = [
  ToolErrorCodes.RESOURCE_NOT_FOUND,
  ToolErrorCodes.RESOURCE_EXHAUSTED,
  ToolErrorCodes.VALIDATION_FAILED,
  ToolErrorCodes.PERMISSION_DENIED,
  ToolErrorCodes.TIMEOUT,
  ToolErrorCodes.INTERNAL_ERROR,
] as const;

/**
 * Pattern that matches an embedded error code prefix at the start of a string.
 * Shell service throws `${CODE}: message`; the bus wraps this as
 * `Request to "${subject}" failed: ${CODE}: message`.
 */
const CODE_PREFIX_PATTERN = new RegExp(`(?:^|failed: )(${EMBEDDED_CODES.join('|')}): (.+)$`, 's');

/**
 * Convert a bus-propagated error into a ToolFailure, preserving the original
 * error code embedded by the shell service handler.
 *
 * Shell service handlers throw errors with a CODE-prefixed message, e.g.
 * "RESOURCE_NOT_FOUND: Shell not found: xyz". The bus wraps those as a
 * RequestError with the original message appended after "failed: ". This function extracts the
 * embedded code so callers receive the precise error category rather than a
 * generic `EXECUTION_ERROR`.
 * @param error - The error caught in a shell tool's execute handler
 * @returns ToolFailure with the correct error code and stripped message
 */
export function shellBusError(error: unknown): ToolFailure {
  const raw = error instanceof Error ? error.message : String(error);
  const match = CODE_PREFIX_PATTERN.exec(raw);
  if (match) {
    const code = match[1]!;
    const message = match[2]!;
    return toolError(code, message);
  }
  return toolError(ToolErrorCodes.EXECUTION_ERROR, raw);
}
