/**
 * shell_status tool - Check the status of a shell process.
 *
 * Returns running/exited state, exit code, output sizes, and runtime.
 */

import type { MakaioContext } from '@makaio/core';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { ShellManager } from '../manager/shell-manager.js';
import { ShellStatusInputSchema, ShellStatusOutputSchema } from '../types.js';

/**
 * Creates the shell_status tool.
 *
 * This tool checks the current status of a shell process, including
 * whether it's still running, its exit code, output buffer sizes,
 * and total runtime.
 * @param manager - ShellManager instance for looking up shell instances
 * @returns Tool definition for shell_status
 */
export function shellStatusTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_status',
    description: 'Check the status of a shell (running/exited), exit code, and output sizes.',
    annotations: { readOnly: true },
    inputSchema: ShellStatusInputSchema,
    outputSchema: ShellStatusOutputSchema,
    async execute(input, _context: MakaioContext) {
      const instance = manager.get(input.shellId);

      if (!instance) {
        return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Shell not found: ${input.shellId}`);
      }

      const stats = instance.getBufferStats();

      return toolSuccess({
        shellId: instance.shellId,
        status: instance.getStatus(),
        exitCode: instance.getExitCode(),
        stdoutSize: stats.stdoutSize,
        stderrSize: stats.stderrSize,
        truncated: stats.truncated,
        runtimeMs: instance.getRuntimeMs(),
      });
    },
  });
}
