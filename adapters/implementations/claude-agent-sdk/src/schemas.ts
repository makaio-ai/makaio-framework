import { z } from 'zod';

/**
 * Zod schema for Claude Code provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const ClaudeCodeProviderConfigSchema = z.object({
  /**
   * Use SDK immediate message mode for faster streaming responses.
   * When enabled, messages are streamed immediately without buffering.
   */
  useSdkImmediateMessageMode: z.boolean().default(false).meta({
    title: 'Immediate Message Mode',
    description: 'Use SDK immediate message mode for faster responses',
  }),
});

/**
 * Inferred TypeScript type from the schema.
 */
export type ClaudeCodeProviderConfig = z.infer<typeof ClaudeCodeProviderConfigSchema>;
