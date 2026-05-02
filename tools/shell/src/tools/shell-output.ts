/**
 * shell_output tool - Retrieve raw output from a shell with pagination support.
 *
 * Supports stdout, stderr, or both streams interleaved.
 */

import type { MakaioContext } from '@makaio/core';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { ShellManager } from '../manager/shell-manager.js';
import { ShellOutputInputSchema, ShellOutputOutputSchema } from '../types.js';

/**
 * Creates the shell_output tool.
 *
 * This tool retrieves raw output from a shell process with pagination
 * support for handling large outputs. Can return stdout, stderr, or
 * both streams interleaved.
 * @param manager - ShellManager instance for looking up shell instances
 * @returns Tool definition for shell_output
 */
export function shellOutputTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_output',
    description: 'Retrieve raw output from a shell with pagination support.',
    annotations: { readOnly: true },
    inputSchema: ShellOutputInputSchema,
    outputSchema: ShellOutputOutputSchema,
    async execute(input, _context: MakaioContext) {
      const instance = manager.get(input.shellId);

      if (!instance) {
        return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Shell not found: ${input.shellId}`);
      }

      const stream = input.stream ?? 'both';
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 10000;

      const output = instance.getOutput(stream, offset, limit);

      return toolSuccess({
        content: output.content,
        stream: output.stream,
        offset: output.offset,
        totalSize: output.totalSize,
        hasMore: output.hasMore,
      });
    },
  });
}
