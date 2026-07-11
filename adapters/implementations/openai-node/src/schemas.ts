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

  /**
   * Opt into the Factory Gateway's content-free correlation header contract.
   * Disabled by default so internal identifiers are never sent to arbitrary
   * OpenAI-compatible endpoints.
   */
  requestCorrelationHeaders: z.literal('factory-v1').optional().meta({
    title: 'Request correlation headers',
    description: 'Send the Factory Gateway v1 usage-correlation header allowlist',
  }),

  /**
   * Whether the provider accepts `response_format: json_schema` alongside
   * `tools` in the same request.
   *
   * When `true`, the adapter sends structured output via `response_format`
   * directly and skips the synthetic finalizer-tool workaround.
   * When `false`, the adapter injects a `makaio_submit_structured_output`
   * tool and suppresses `response_format` to avoid provider rejection.
   *
   * Resolved automatically per provider when omitted (native OpenAI = true).
   */
  supportsResponseFormatWithTools: z.boolean().optional().meta({
    title: 'Supports response_format with tools',
    description: 'Whether the provider handles json_schema response_format alongside tool calls',
  }),

  /**
   * Whether the provider accepts `strict: true` on `json_schema`
   * response format payloads.
   *
   * When `true`, the API guarantees schema conformance. When `false`,
   * the `strict` flag is omitted even if the schema descriptor requests it.
   *
   * Resolved automatically per provider when omitted (native OpenAI = true).
   */
  supportsStructuredOutputStrict: z.boolean().optional().meta({
    title: 'Supports strict structured output',
    description: 'Whether the provider supports strict: true on json_schema response format',
  }),
});

/**
 * Provider settings input type (pre-validation, fields optional).
 */
export type OpenAINodeProviderSettings = z.input<typeof OpenAINodeProviderConfigSchema>;
