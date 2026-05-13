import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellGrepInputSchema, ShellGrepOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Search shell output using regex with context lines and pagination.
 */
export const shellGrepTool = defineTool({
  name: 'shell_grep',
  description: 'Search shell output using regex with context lines and pagination.',
  annotations: { readOnly: true },
  inputSchema: ShellGrepInputSchema,
  outputSchema: ShellGrepOutputSchema,
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.grep, input);

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
