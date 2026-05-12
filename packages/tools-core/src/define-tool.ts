import type { z } from 'zod';
import type { ToolAnnotations } from '@makaio/contracts';
import type { ToolDefinition, ToolExecutionContext, ToolResult } from './types.js';

/**
 * Configuration object for defining a tool.
 * Provides ergonomic API for creating ToolDefinition instances.
 * @typeParam TInput - Zod schema type for input validation
 * @typeParam TOutput - Zod schema type for output validation
 */
export interface DefineToolConfig<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  /** Unique tool name (identifier) */
  name: string;

  /** Human-readable description of what the tool does */
  description: string;

  /** Optional behavior annotations for consumers */
  annotations?: ToolAnnotations;

  /** Zod schema for input validation */
  inputSchema: TInput;

  /** Zod schema for output validation */
  outputSchema: TOutput;

  /**
   * Tool execution function.
   * @param input - Validated input matching inputSchema
   * @param context - Execution context with cwd, env, platform, sessionId, bus, etc.
   * @returns Promise resolving to success with data or failure with error
   */
  execute: (input: z.infer<TInput>, context: ToolExecutionContext) => Promise<ToolResult<z.infer<TOutput>>>;
}

/**
 * Creates a ToolDefinition from a configuration object.
 *
 * Provides a clean builder API for defining tools with full type inference.
 * The returned ToolDefinition can be used directly or registered with a toolset.
 * @typeParam TInput - Zod schema type for input validation
 * @typeParam TOutput - Zod schema type for output validation
 * @param config - Tool configuration
 * @returns Fully typed ToolDefinition
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
 *
 * const ReadFileInputSchema = z.object({
 *   path: z.string().describe('File path to read'),
 *   encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
 * });
 *
 * const ReadFileOutputSchema = z.object({
 *   content: z.string(),
 *   size: z.number(),
 * });
 *
 * const readFileTool = defineTool({
 *   name: 'readFile',
 *   description: 'Reads a file from the filesystem',
 *   annotations: { readOnly: true },
 *   inputSchema: ReadFileInputSchema,
 *   outputSchema: ReadFileOutputSchema,
 *   execute: async (input, context) => {
 *     const fullPath = path.resolve(context.cwd, input.path);
 *
 *     try {
 *       const content = await fs.readFile(fullPath, input.encoding);
 *       const stats = await fs.stat(fullPath);
 *       return toolSuccess({ content, size: stats.size });
 *     } catch (err) {
 *       return toolError(
 *         ToolErrorCodes.RESOURCE_NOT_FOUND,
 *         `Failed to read file: ${fullPath}`
 *       );
 *     }
 *   },
 * });
 * ```
 */
export function defineTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  config: DefineToolConfig<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return {
    metadata: {
      name: config.name,
      description: config.description,
      annotations: config.annotations,
    },
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    execute: config.execute,
  };
}
