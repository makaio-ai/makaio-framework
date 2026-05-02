import type { z } from 'zod';
import { defineToolset, type AnyToolDefinition, type ToolDefinition } from '@makaio/tools-core';
import { ShellManager } from './manager/shell-manager.js';
import { ShellConstraintsSchema } from './schemas.js';
import {
  shellExecTool,
  shellStatusTool,
  shellOutputTool,
  shellGrepTool,
  shellSendTool,
  shellKillTool,
} from './tools/index.js';

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

export interface CreateShellToolsetOptions {
  /** Existing ShellManager instance (creates new if not provided) */
  manager?: ShellManager;
}

/**
 * Create the shell toolset with all shell execution tools.
 *
 * The toolset includes:
 * - `shell_exec` - Start a shell command in the background
 * - `shell_status` - Check status of a running/exited shell
 * - `shell_output` - Retrieve raw output with pagination
 * - `shell_grep` - Search output with regex and context lines
 * - `shell_send` - Send input to stdin of a running shell
 * - `shell_kill` - Terminate a running shell
 * @param options - Optional configuration for the toolset
 * @returns Object containing the toolset and the ShellManager instance
 * @example
 * ```typescript
 * import { createShellToolset } from '@makaio/tools-shell';
 * import { ToolRegistry } from '@makaio/services-core/tools';
 *
 * const { toolset, manager } = createShellToolset();
 * const registry = new ToolRegistry();
 * await registry.register(toolset);
 *
 * // Execute shell_exec
 * const result = await registry.execute('shell_exec', {
 *   command: 'npm test',
 *   colors: false,
 * });
 * ```
 */
export function createShellToolset(options: CreateShellToolsetOptions = {}) {
  const manager = options.manager ?? new ShellManager();
  manager.startCleanupTimer();

  const toolset = defineToolset({
    name: 'shell',
    description: 'Cross-platform shell execution tools for AI agents',
    version: '0.1.0',
    tools: [
      widenTool(shellExecTool(manager)),
      widenTool(shellStatusTool(manager)),
      widenTool(shellOutputTool(manager)),
      widenTool(shellGrepTool(manager)),
      widenTool(shellSendTool(manager)),
      widenTool(shellKillTool(manager)),
    ],
    configSchema: ShellConstraintsSchema,
  });

  return { toolset, manager };
}
