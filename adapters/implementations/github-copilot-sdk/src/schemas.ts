import { z } from 'zod';

/**
 * Zod schema for GitHub Copilot SDK provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const GitHubCopilotSdkProviderConfigSchema = z.object({
  /**
   * Maximum events to retain in FIFO buffer.
   */
  maxMessages: z.number().optional().meta({
    title: 'Max Messages',
    description: 'Maximum messages in conversation history',
  }),

  /**
   * Enable debug logging.
   */
  debug: z.boolean().default(false).meta({
    title: 'Debug Mode',
    description: 'Enable debug logging',
  }),
});

/**
 * Zod schema for GitHub Copilot SDK credential input.
 *
 * Used for:
 * 1. Write-only credential capture in settings UI
 * 2. Secure storage in credential service
 */
export const GitHubCopilotSdkCredentialSchema = z.object({
  /**
   * GitHub Copilot token (from authenticated CLI session).
   */
  token: z.string().optional().meta({
    title: 'Copilot Token',
    description: 'Stored securely (not saved in config)',
    format: 'password',
  }),
});

/**
 * Provider settings input type (pre-validation, fields optional).
 */
export type GitHubCopilotSdkProviderSettings = z.input<typeof GitHubCopilotSdkProviderConfigSchema>;

/**
 * Inferred TypeScript type for credential values.
 */
export type GitHubCopilotSdkCredentialConfig = z.infer<typeof GitHubCopilotSdkCredentialSchema>;
