import { z } from 'zod';
import { SystemPromptSchema } from '../../shared/index.js';

/**
 * Runtime options for agent execution.
 *
 * `allowedTools`/`disallowedTools`: Makaio tool names; format and semantics: `ToolLists`
 * in `@makaio/contracts` tool-names.
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

  /** Makaio tool names; format and semantics: `ToolLists` in `@makaio/contracts` tool-names. */
  allowedTools: z.array(z.string()).optional(),

  /** Makaio tool names; format and semantics: `ToolLists` in `@makaio/contracts` tool-names. */
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
