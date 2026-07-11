import { z } from 'zod';

/**
 * Zod schema for Claude Code tmux provider-specific configuration.
 *
 * Smaller surface than the CLI adapter — no `--max-budget-usd` since the
 * session is long-lived and budget tracking is handled at the Makaio level.
 */
export const ClaudeCodeTmuxProviderConfigSchema = z
  .object({
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

    /**
     * tmux server name passed via `tmux -L`.
     *
     * Defaults to the adapter's production server. Tests use this seam to isolate
     * each Vitest worker from stale tmux sessions left by interrupted runs.
     */
    tmuxServerName: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/, 'tmuxServerName may contain only letters, digits, dot, underscore, and hyphen')
      .min(1)
      .max(64, 'tmuxServerName must be 64 characters or fewer')
      .optional()
      .meta({
        title: 'tmux Server Name',
        description: 'tmux server name passed with -L. Defaults to the adapter-managed server.',
      }),
  })
  .strict();

/** Inferred TypeScript type from the provider config schema. */
export type ClaudeCodeTmuxProviderConfig = z.infer<typeof ClaudeCodeTmuxProviderConfigSchema>;
