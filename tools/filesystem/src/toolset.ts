import type { z } from 'zod';
import { defineToolset, type AnyToolDefinition, type ToolDefinition } from '@makaio/tools-core';
import { readFileTool, writeFileTool, listDirectoryTool, deleteFileTool } from './tools/index.js';

/**
 * Widens a specifically-typed tool to the base AnyToolDefinition type.
 *
 * This helper function handles TypeScript's variance checking on function parameters.
 * The assignment is safe because ToolDefinition extends AnyToolDefinition:
 * 1. We're widening from a specific type to a more general type
 * 2. Input validation still happens via the tool's Zod schema
 * 3. Runtime behavior is unchanged
 * @param tool - Tool with specific Zod schema types
 * @returns Tool typed as AnyToolDefinition for use in collections
 */
function widenTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  tool: ToolDefinition<TInput, TOutput>,
): AnyToolDefinition {
  // Method syntax on execute enables bivariant checking, making this assignable
  return tool;
}

/**
 * Filesystem toolset for the Makaio Framework.
 *
 * Provides cross-platform file system operations including reading,
 * writing, and listing files and directories.
 *
 * ## Tools
 * - `read_file` - Read file contents (text or binary)
 * - `write_file` - Write content to files
 * - `list_directory` - List directory contents
 * - `delete_file` - Delete a file
 *
 * ## Path Resolution
 * All paths are resolved relative to `context.cwd` unless absolute.
 * Paths are validated against `context.constraints.allowedDirectories`
 * when defined (`[]` denies all; `undefined` is unrestricted).
 *
 * ## Constraints
 * The toolset respects these optional constraints in `MakaioContext`:
 * - `allowedDirectories?: string[]` - Directory allow-list (`[]` denies all)
 * - `maxFileSize: number` - Maximum file size in bytes
 * @example
 * ```typescript
 * import { ToolRegistry } from '@makaio/tools-core';
 * import { filesystemToolset } from '@makaio/tools-filesystem';
 *
 * const registry = new ToolRegistry();
 * await registry.register(filesystemToolset);
 *
 * // Execute read_file
 * const result = await registry.execute('read_file', {
 *   path: './package.json',
 * });
 * ```
 */
export const filesystemToolset = defineToolset({
  name: 'filesystem',
  description: 'Cross-platform file system operations for reading, writing, and listing files and directories.',
  version: '0.1.0',
  tools: [widenTool(readFileTool), widenTool(writeFileTool), widenTool(listDirectoryTool), widenTool(deleteFileTool)],
});
