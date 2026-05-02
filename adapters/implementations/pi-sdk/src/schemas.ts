import { z } from 'zod';

/**
 * Tool suppression mode values for the Pi SDK.
 *
 * Maps to the `noTools` option in `createAgentSession()`:
 * - `'all'`: start with no tools enabled
 * - `'builtin'`: disable the default built-in tools (read, bash, edit, write)
 *   but keep extension/custom tools enabled
 */
export const NoToolsValues = ['all', 'builtin'] as const;

/**
 * Zod schema for Pi SDK provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 *
 * Note: `cwd` and `model` come from the adapter options (BaseAgentConnectorConfig),
 * not from this provider config. This schema only contains provider-specific settings.
 */
export const PiSdkProviderConfigSchema = z.object({
  /**
   * Tool suppression mode.
   * Controls which built-in tools are disabled at session creation.
   * - `'all'`: disable all tools
   * - `'builtin'`: disable only built-in tools (bash, read, edit, write)
   */
  noTools: z.enum(NoToolsValues).optional().meta({
    title: 'No Tools',
    description: "Tool suppression mode: 'all' disables all tools, 'builtin' disables only built-in tools",
  }),
});

/**
 * Configuration type for the Pi SDK adapter.
 */
export type PiSdkProviderConfig = z.infer<typeof PiSdkProviderConfigSchema>;
