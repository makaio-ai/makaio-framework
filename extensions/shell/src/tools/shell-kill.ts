import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellKillInputSchema, ShellKillOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Terminate a running shell with the specified signal.
 */
export const shellKillTool = defineTool({
  name: 'shell_kill',
  description: 'Terminate a running shell with the specified signal.',
  annotations: { destructive: true },
  inputSchema: ShellKillInputSchema,
  outputSchema: ShellKillOutputSchema,
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.kill, input);

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
