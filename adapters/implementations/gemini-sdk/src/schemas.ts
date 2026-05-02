import { z } from 'zod';

/**
 * Zod schema for Gemini SDK provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const GeminiSdkProviderConfigSchema = z.object({
  /**
   * Enable debug logging in Gemini SDK.
   */
  debugMode: z.boolean().default(false).meta({
    title: 'Debug Mode',
    description: 'Enable debug logging',
  }),

  /**
   * Enable checkpointing for conversation state.
   */
  checkpointing: z.boolean().default(false).meta({
    title: 'Checkpointing',
    description: 'Enable session checkpointing',
  }),
});

/**
 * Provider settings input type (pre-validation, fields optional).
 */
export type GeminiSdkProviderSettings = z.input<typeof GeminiSdkProviderConfigSchema>;
