import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellExecInputSchema, ShellExecOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Starts a shell command in the background.
 * Returns a shell ID for subsequent operations (status, output, kill).
 */
export const shellExecTool = defineTool({
  name: 'shell_exec',
  description: 'Start a shell command in the background. Returns a shell ID for subsequent operations.',
  annotations: { destructive: true },
  inputSchema: ShellExecInputSchema,
  outputSchema: ShellExecOutputSchema,
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.exec, {
        input,
        context: {
          cwd: context.cwd,
          platform: context.platform,
          constraints: context.constraints,
        },
      });

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
