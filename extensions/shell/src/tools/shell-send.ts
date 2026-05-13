import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellSendInputSchema, ShellSendOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Send input to the stdin of a running shell.
 */
export const shellSendTool = defineTool({
  name: 'shell_send',
  description: 'Send input to the stdin of a running shell.',
  annotations: { destructive: true },
  inputSchema: ShellSendInputSchema,
  outputSchema: ShellSendOutputSchema,
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.send, input);

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
