/**
 * shell_exec tool - Starts a shell command in the background.
 *
 * Returns a shell ID for subsequent operations (status, output, kill).
 */

import type { MakaioContext } from '@makaio/core';
import { defineTool, toolSuccess, toolError, ToolErrorCodes } from '@makaio/tools-core';
import type { ShellManager } from '../manager/shell-manager.js';
import { ShellExecInputSchema, ShellExecOutputSchema, DEFAULT_CONSTRAINTS, type ShellConstraints } from '../types.js';

/**
 * Merges context constraints with default constraints.
 * @param context - Execution context with optional shell constraints
 * @returns Complete constraints with defaults applied
 */
function mergeConstraints(context: MakaioContext): Required<ShellConstraints> {
  const shellConstraints = (context.constraints?.shell ?? {}) as ShellConstraints;
  return { ...DEFAULT_CONSTRAINTS, ...shellConstraints };
}

/**
 * Creates the shell_exec tool.
 *
 * This tool starts a shell command in the background and returns a shell ID
 * that can be used to check status, retrieve output, or terminate the process.
 * @param manager - ShellManager instance for creating shell processes
 * @returns Tool definition for shell_exec
 */
export function shellExecTool(manager: ShellManager) {
  return defineTool({
    name: 'shell_exec',
    description: 'Start a shell command in the background. Returns a shell ID for subsequent operations.',
    annotations: { destructive: true },
    inputSchema: ShellExecInputSchema,
    outputSchema: ShellExecOutputSchema,
    async execute(input, context: MakaioContext) {
      const constraints = mergeConstraints(context);

      // Determine effective timeout (input can only shorten, not extend)
      let timeout: number | undefined;
      if (input.timeout !== undefined) {
        timeout = Math.min(input.timeout, constraints.timeout);
      }

      try {
        const instance = await manager.create({
          command: input.command,
          cwd: input.cwd ?? context.cwd,
          env: input.env ?? {},
          platform: context.platform,
          colors: input.colors,
          timeout,
          constraints,
        });

        return toolSuccess({
          shellId: instance.shellId,
          pid: instance.pid,
          shell: instance.shell,
        });
      } catch (err) {
        // Check for max concurrent shells error
        if (err instanceof Error && err.message.includes('Max concurrent shells')) {
          return toolError(ToolErrorCodes.RESOURCE_EXHAUSTED, err.message);
        }
        throw err;
      }
    },
  });
}
