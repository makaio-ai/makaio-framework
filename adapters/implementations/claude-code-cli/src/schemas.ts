import { z } from 'zod';

/**
 * Zod schema for Claude Code CLI provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const ClaudeCodeCliProviderConfigSchema = z.object({
  /**
   * Maximum budget in USD for the CLI session.
   * When set, passes --max-budget-usd to the claude CLI.
   */
  maxBudgetUsd: z.number().positive().optional().meta({
    title: 'Max Budget (USD)',
    description: 'Maximum dollar amount to spend on API calls',
  }),
  /**
   * Opt-in flag to pass --dangerously-skip-permissions to the claude CLI.
   * Defaults to false when omitted. Must be explicitly set to true to enable.
   */
  skipPermissions: z.boolean().optional().meta({
    title: 'Skip Permissions',
    description: 'Auto-approve all tool use (dangerously-skip-permissions). Only enable in trusted environments.',
  }),
  /**
   * Absolute path to the `claude` CLI binary.
   * When omitted, falls back to `'claude'` (resolved via PATH).
   */
  binaryPath: z.string().optional().meta({
    title: 'Binary Path',
    description: 'Absolute path to the claude CLI binary. Defaults to resolving "claude" from PATH.',
  }),
});

/**
 * Inferred TypeScript type from the schema.
 */
export type ClaudeCodeCliProviderConfig = z.infer<typeof ClaudeCodeCliProviderConfigSchema>;
