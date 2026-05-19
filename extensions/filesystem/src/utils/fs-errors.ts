import { toolError, ToolErrorCodes, errorToToolResult, type ToolFailure } from '@makaio/tools-core';

/**
 * Map a filesystem error to a structured tool failure.
 * @param err - The caught error.
 * @param resolvedPath - Resolved path for error messages.
 * @returns A ToolFailure with an appropriate error code.
 */
export function handleFsError(err: unknown, resolvedPath: string): ToolFailure {
  if (err instanceof Error && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') {
      return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `File not found: ${resolvedPath}`);
    }

    if (code === 'EACCES' || code === 'EPERM') {
      return toolError(ToolErrorCodes.PERMISSION_DENIED, `Permission denied: ${resolvedPath}`);
    }

    if (code === 'EISDIR') {
      return toolError(ToolErrorCodes.VALIDATION_FAILED, `Path is a directory, not a file: ${resolvedPath}`);
    }
  }

  return errorToToolResult(err);
}
