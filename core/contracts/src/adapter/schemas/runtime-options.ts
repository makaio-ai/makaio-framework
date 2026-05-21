import { z } from 'zod';
import { SystemPromptSchema } from '../../shared/index.js';

/**
 * Runtime options for agent execution.
 *
 * SEAM: Tool naming is adapter-specific and not yet normalized.
 * Use `allowedTools`/`disallowedTools` with provider-specific tool names.
 * @example
 * ```typescript
 * // Claude Code adapter
 * runtimeOptions: {
 *   cwd: '/path/to/project',
 *   allowedTools: ['Read', 'WebSearch'],  // Claude Code tool names
 * }
 *
 * // Future: Other adapters will have different tool names
 * runtimeOptions: {
 *   allowedTools: ['file_read', 'web_search'],  // Hypothetical OpenAI adapter
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
   * Allowed tool names (adapter-specific).
   * Empty array = disable all tools.
   * Undefined = use adapter defaults.
   */
  allowedTools: z.array(z.string()).optional(),

  /**
   * Disallowed tool names (adapter-specific).
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
