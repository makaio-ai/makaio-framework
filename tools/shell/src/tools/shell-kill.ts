/**
 * shell_kill tool - Terminate a running shell with the specified signal.
 */

import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { MakaioContext } from '@makaio/core';
import type { ShellManager } from '../manager/shell-manager.js';
import { ShellKillInputSchema, ShellKillOutputSchema, type ShellKillInput, type ShellKillOutput } from '../types.js';

/**
 * Creates the shell_kill tool bound to a ShellManager instance.
 * @param manager - ShellManager instance to use for shell lookups
 * @returns ToolDefinition for shell_kill
 */
export function shellKillTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_kill',
    description: 'Terminate a running shell with the specified signal.',
    annotations: { destructive: true },
    inputSchema: ShellKillInputSchema,
    outputSchema: ShellKillOutputSchema,

    execute: async (
      input: ShellKillInput,
      _context: MakaioContext,
    ): Promise<ReturnType<typeof toolSuccess<ShellKillOutput>> | ReturnType<typeof toolError>> => {
      // Get shell instance
      const instance = manager.get(input.shellId);
      if (!instance) {
        return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Shell not found: ${input.shellId}`);
      }

      // Determine signal to use
      const signal = input.signal ?? 'SIGTERM';

      // Kill the process
      const killed = await instance.kill(signal);

      const result: ShellKillOutput = {
        killed,
        signal,
      };

      return toolSuccess(result);
    },
  });
}
