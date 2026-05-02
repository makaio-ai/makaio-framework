import { z } from 'zod';

/**
 * Zod schema for OpenAI Node provider-specific configuration.
 *
 * Used for:
 * 1. Type-safe config resolution
 * 2. Serialization to JSON Schema for web-ui form generation
 * 3. Runtime validation
 */
export const OpenAINodeProviderConfigSchema = z.object({
  /**
   * Base URL for OpenAI-compatible APIs.
   * Defaults to OpenAI's API. Use for alternatives like:
   * - NanoGPT: 'https://nano-gpt.com/api/v1'
   * - Azure OpenAI: 'https://\{resource\}.openai.azure.com/openai/deployments/\{deployment\}'
   * - Local LLMs: 'http://localhost:1234/v1'
   */
  baseUrl: z.string().optional().meta({
    title: 'Base URL',
    description: 'API endpoint for OpenAI-compatible providers',
  }),
});

/**
 * Zod schema for OpenAI Node credential input.
 *
 * Used for:
 * 1. Write-only credential capture in settings UI
 * 2. Secure storage in credential service
 */
export const OpenAINodeCredentialSchema = z.object({
  /**
   * API key for OpenAI.
   */
  apiKey: z.string().optional().meta({
    title: 'API Key',
    description: 'Stored securely (not saved in config)',
    format: 'password',
  }),
});

/**
 * Provider settings input type (pre-validation, fields optional).
 */
export type OpenAINodeProviderSettings = z.input<typeof OpenAINodeProviderConfigSchema>;
