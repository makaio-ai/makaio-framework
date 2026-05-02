/**
 * shell_send tool - Send input to the stdin of a running shell.
 */

import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { MakaioContext } from '@makaio/core';
import type { ShellManager } from '../manager/shell-manager.js';
import { ShellSendInputSchema, ShellSendOutputSchema, type ShellSendInput, type ShellSendOutput } from '../types.js';

/**
 * Creates the shell_send tool bound to a ShellManager instance.
 * @param manager - ShellManager instance to use for shell lookups
 * @returns ToolDefinition for shell_send
 */
export function shellSendTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_send',
    description: 'Send input to the stdin of a running shell.',
    annotations: { destructive: true },
    inputSchema: ShellSendInputSchema,
    outputSchema: ShellSendOutputSchema,

    execute: async (
      input: ShellSendInput,
      _context: MakaioContext,
    ): Promise<ReturnType<typeof toolSuccess<ShellSendOutput>> | ReturnType<typeof toolError>> => {
      // Get shell instance
      const instance = manager.get(input.shellId);
      if (!instance) {
        return toolError(ToolErrorCodes.RESOURCE_NOT_FOUND, `Shell not found: ${input.shellId}`);
      }

      // Send input to stdin
      const bytesWritten = await instance.sendInput(input.input);

      const result: ShellSendOutput = {
        sent: bytesWritten > 0,
        bytesWritten,
      };

      return toolSuccess(result);
    },
  });
}
