import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellStatusInputSchema, ShellStatusOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Check the status of a shell process.
 * Returns running/exited state, exit code, output sizes, and runtime.
 */
export const shellStatusTool = defineTool({
  name: 'shell_status',
  description: 'Check the status of a shell (running/exited), exit code, and output sizes.',
  annotations: { readOnly: true },
  inputSchema: ShellStatusInputSchema,
  outputSchema: ShellStatusOutputSchema,
  /**
   * Execute the shell status check.
   * @param input - Shell status input with the shell ID.
   * @param context - Tool execution context with the shell service bus.
   * @returns Shell status result or a tool error.
   */
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.status, input);

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
