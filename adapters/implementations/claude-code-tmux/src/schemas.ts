import * as path from 'node:path';
import { z } from 'zod';

/**
 * Zod schema for Claude Code tmux provider-specific configuration.
 *
 * Smaller surface than the CLI adapter — no `--max-budget-usd` since the
 * session is long-lived and budget tracking is handled at the Makaio level.
 */
export const ClaudeCodeTmuxProviderConfigSchema = z.object({
  /**
   * Absolute path to the `claude` CLI binary.
   * When omitted, falls back to `'claude'` (resolved via PATH).
   */
  binaryPath: z
    .string()
    .refine((value) => path.isAbsolute(value), 'binaryPath must be an absolute path')
    .optional()
    .meta({
      title: 'Binary Path',
      description: 'Absolute path to the claude CLI binary. Defaults to resolving "claude" from PATH.',
    }),

  /**
   * Whether to pass `--dangerously-skip-permissions` when launching Claude Code.
   *
   * Defaults to `true` because tool approval is handled by the Makaio harness
   * via MCP, not by Claude Code's native permission system. Without this flag,
   * Claude Code would prompt for approval in the tmux pane AND the adapter
   * would also prompt via MCP — causing double prompting.
   *
   * Set to `false` only if you want Claude Code's native permission prompts
   * instead of (or in addition to) the Makaio harness approval flow.
   */
  skipPermissions: z.boolean().default(true).meta({
    title: 'Skip Permissions',
    description:
      'Pass --dangerously-skip-permissions to Claude Code. Defaults to true because tool approval is handled by the Makaio harness via MCP.',
  }),
});

/** Inferred TypeScript type from the provider config schema. */
export type ClaudeCodeTmuxProviderConfig = z.infer<typeof ClaudeCodeTmuxProviderConfigSchema>;
