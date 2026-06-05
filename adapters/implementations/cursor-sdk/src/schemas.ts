import { z } from 'zod';

/**
 * Zod schema for Cursor SDK provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 *
 * Note: `cwd` and `model` come from the adapter options (BaseAgentConnectorConfig),
 * not from this provider config. This schema only contains provider-specific settings.
 */
export const CursorSdkProviderConfigSchema = z.object({
  /**
   * Execution mode for the Cursor agent.
   * - `'agent'`: the agent executes changes directly
   * - `'plan'`: the agent only plans, does not apply changes
   */
  mode: z.enum(['agent', 'plan']).optional().meta({
    title: 'Mode',
    description:
      "Whether the agent executes changes or only plans them. 'agent' applies changes; 'plan' produces a plan only.",
  }),
});

/**
 * Configuration type for the Cursor SDK adapter.
 */
export type CursorSdkProviderConfig = z.infer<typeof CursorSdkProviderConfigSchema>;
