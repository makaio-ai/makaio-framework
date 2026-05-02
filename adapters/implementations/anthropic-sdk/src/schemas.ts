import { z } from 'zod';

/**
 * Zod schema for Anthropic SDK provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const AnthropicSdkProviderConfigSchema = z.object({
  /**
   * Base URL for Anthropic-compatible APIs.
   * Defaults to Anthropic's API. Use for alternatives like:
   * - Z.ai proxy: 'https://api.z.ai/api/anthropic'
   */
  baseUrl: z.string().optional().meta({
    title: 'Base URL',
    description: 'Override the default Anthropic API URL',
  }),
  /**
   * Maximum number of tokens to generate per request.
   * Defaults to 32,000 when not set.
   */
  maxTokens: z.number().int().positive().optional().meta({
    title: 'Max Tokens',
    description: 'Maximum number of tokens to generate per API request (default: 32,000)',
  }),
});

/**
 * Zod schema for Anthropic SDK credential input.
 *
 * Used for:
 * 1. Write-only credential capture in settings UI
 * 2. Secure storage in credential service
 */
export const AnthropicSdkCredentialSchema = z.object({
  /**
   * API key for Anthropic.
   */
  apiKey: z.string().optional().meta({
    title: 'API Key',
    format: 'password',
    description: 'Anthropic API key',
  }),
});

/**
 * Provider settings input type (pre-validation, fields optional).
 */
export type AnthropicSdkProviderSettings = z.input<typeof AnthropicSdkProviderConfigSchema>;
