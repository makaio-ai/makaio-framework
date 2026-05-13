import { defineTool, toolError, toolSuccess, ToolErrorCodes } from '@makaio/tools-core';
import { ShellSubjects } from '../bus/namespace.js';
import { ShellOutputInputSchema, ShellOutputOutputSchema } from '../types.js';
import { shellBusError } from './bus-error.js';

/**
 * Retrieve raw output from a shell with pagination support.
 * Supports stdout, stderr, or both streams interleaved.
 */
export const shellOutputTool = defineTool({
  name: 'shell_output',
  description: 'Retrieve raw output from a shell with pagination support.',
  annotations: { readOnly: true },
  inputSchema: ShellOutputInputSchema,
  outputSchema: ShellOutputOutputSchema,
  /**
   * Execute shell output retrieval.
   * @param input - Shell output request with shell ID, stream, offset, and limit.
   * @param context - Tool execution context with the shell service bus.
   * @returns Shell output content or a tool error.
   */
  async execute(input, context) {
    if (!context.bus) {
      return toolError(ToolErrorCodes.EXECUTION_ERROR, 'Shell service bus is not available');
    }

    try {
      const result = await context.bus.requestOptional(ShellSubjects.output, input);

      if (!result.handled) {
        return toolError(ToolErrorCodes.TOOL_NOT_FOUND, 'Shell service is not available');
      }

      return toolSuccess(result.data);
    } catch (error) {
      return shellBusError(error);
    }
  },
});
