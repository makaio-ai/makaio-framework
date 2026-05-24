/**
 * \@makaio/tools-core
 *
 * Foundational tool execution infrastructure for the Makaio Framework.
 *
 * ## Features
 * - Pure function tools with validated I/O schemas
 * - Toolset grouping for related tools
 * - Registry with bus integration via `@makaio/services-core/tools`
 * - Export to MCP and OpenAI function formats
 *
 * ## Basic Usage
 *
 * ### Define a Tool
 * ```typescript
 * import { z } from 'zod';
 * import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
 *
 * const echoTool = defineTool({
 *   name: 'echo',
 *   description: 'Echoes the input message',
 *   annotations: { readOnly: true },
 *   inputSchema: z.object({ message: z.string() }),
 *   outputSchema: z.object({ echo: z.string() }),
 *   execute: async (input, context) => {
 *     return toolSuccess({ echo: input.message });
 *   },
 * });
 * ```
 *
 * ### Create a Toolset
 * ```typescript
 * import { defineToolset } from '@makaio/tools-core';
 *
 * const utilsToolset = defineToolset({
 *   name: 'utils',
 *   description: 'Utility tools',
 *   version: '1.0.0',
 *   tools: [echoTool, otherTool],
 * });
 * ```
 *
 * ### Register and Execute
 * ```typescript
 * import { ToolRegistry } from '@makaio/services-core/tools';
 *
 * const registry = new ToolRegistry();
 * await registry.register(utilsToolset);
 *
 * const result = await registry.execute('echo', { message: 'Hello' });
 * if (result.success) {
 *   console.debug(result.data.echo); // 'Hello'
 * }
 * ```
 *
 * ### Export to MCP/OpenAI
 * ```typescript
 * import { toMcpTool, toolsetToOpenAIFunctions } from '@makaio/tools-core';
 *
 * const mcpTool = toMcpTool(echoTool);
 * const openAIFunctions = toolsetToOpenAIFunctions(utilsToolset);
 * ```
 */

export type { ToolAnnotations } from '@makaio/contracts';
export type {
  AnyToolDefinition,
  BusLike,
  ToolDefinition,
  ToolError,
  ToolExecutionContext,
  ToolFailure,
  ToolInfo,
  ToolMetadata,
  ToolResult,
  Toolset,
  ToolsetMetadata,
  ToolSuccess,
} from './types.js';

export {
  errorToToolResult,
  ToolErrorCodes,
  type ToolErrorCode,
  ToolExecutionError,
  toolError,
  toolSuccess,
} from './errors.js';

export { defineTool, type DefineToolConfig } from './define-tool.js';
export { defineToolset, type DefineToolsetConfig } from './define-toolset.js';

export {
  ensureMcpObjectSchema,
  toMcpTool,
  toOpenAIFunction,
  toolsetToMcpTools,
  toolsetToOpenAIFunctions,
  type ExportOptions,
  type McpToolDefinition,
  type OpenAIFunctionDefinition,
} from './export.js';

export { MemoryStore } from './memory-store.js';

export { validateSessionId, emitEvent, executeCrudOperation } from './tool-utils.js';
export { widenTool } from './widen-tool.js';
export {
  FILE_ACCESS_RULES_KEY,
  extractToolFilePath,
  type FileAccessRuleProvider,
  type FileAccessRules,
} from './file-access.js';
