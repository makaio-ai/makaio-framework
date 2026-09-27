import { z } from 'zod';
import { SystemPromptSchema } from '../../shared/index.js';

/**
 * Runtime options for agent execution.
 *
 * `allowedTools`/`disallowedTools` name tools with the Makaio framework tool names
 * (`read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`, `shell_exec`,
 * `shell_kill`, `spawn_subagent`, `send_to_subagent`), not adapter-native names. MCP tools
 * use `mcp__<server>__<tool>`. `shell_exec` entries may carry a command rule, e.g.
 * `shell_exec(git status)` (exact) or `shell_exec(git log:*)` (prefix; never matches
 * commands containing shell operators). See `@makaio/contracts` `tool-names`
 * (`resolveToolPolicy`).
 * @example
 * ```typescript
 * runtimeOptions: {
 *   cwd: '/path/to/project',
 *   allowedTools: ['read_file', 'shell_exec(git status)'],  // Makaio tool names
 * }
 * ```
 */
export const AdapterRuntimeOptionsSchema = z.object({
  /**
   * Working directory for agent execution.
   * Defaults to MAKAIO_DEFAULT_CWD or os.homedir() if not specified.
   */
  cwd: z.string().optional(),

  /**
   * Allowed tool names (Makaio tool names, or `mcp__<server>__<tool>` for MCP tools).
   * Empty array = disable all tools, including MCP.
   * Undefined = use adapter defaults.
   */
  allowedTools: z.array(z.string()).optional(),

  /**
   * Disallowed tool names, same naming as allowedTools.
   * Takes precedence over allowedTools.
   */
  disallowedTools: z.array(z.string()).optional(),

  /**
   * Directory restrictions for file-system tool execution.
   * - `undefined`: no restriction (use adapter/runtime defaults)
   * - `[]`: deny all filesystem paths
   * - non-empty array: restrict access to listed directories
   */
  allowedDirectories: z.array(z.string()).optional(),

  /**
   * System prompt configuration.
   * - `string`: Replace/set the entire system prompt
   * - `{ mode: 'append', content: string }`: Append to adapter's default system prompt
   */
  systemPrompt: SystemPromptSchema.optional(),
});

export type AdapterRuntimeOptions = z.infer<typeof AdapterRuntimeOptionsSchema>;
