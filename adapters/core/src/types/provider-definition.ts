import type { AdapterProviderDefinitionContract } from '@makaio/contracts';
import type { z } from 'zod';

/**
 * Runtime adapter provider definition pairing a serializable provider definition
 * with optional runtime-only schemas.
 *
 * Extends {@link AdapterProviderDefinitionContract} from `@makaio/contracts` which
 * is the single source of truth for the `definition`, `configSchema`, and
 * `credentialSchema` fields. All fields are inherited from the contract — this
 * type exists to give the shape a domain-specific name used throughout
 * adapter implementation packages and to allow future additions specific to
 * `ai-adapters-core`.
 *
 * Each adapter exports an array of these from its `definition.ts` (via `providers`).
 * The `definition` field contains serializable data (models, endpoints, etc.).
 * The schema fields are runtime-only — used for UI form generation, never serialized.
 * @example
 * ```typescript
 * const anthropicProvider: AdapterProviderDefinition = {
 *   definition: {
 *     id: 'anthropic',
 *     name: 'Anthropic',
 *     endpoints: { anthropic: 'https://api.anthropic.com' },
 *     defaultModel: 'sonnet',
 *     availableModels: [...]
 *   },
 *   credentialSchema: z.object({
 *     apiKey: z.string().describe('Anthropic API Key')
 *   })
 * };
 * ```
 */
export interface AdapterProviderDefinition extends AdapterProviderDefinitionContract {
  /**
   * Provider-specific config schema for UI form generation (runtime-only).
   *
   * Defines provider-specific configuration fields like debugging flags,
   * rate limiting options, or provider-specific features.
   * Not serialized — used for dynamic form generation in the settings UI.
   */
  readonly configSchema?: z.ZodObject<z.ZodRawShape>;

  /**
   * Provider-specific credential schema for secure credential capture (runtime-only).
   *
   * Defines credential fields (apiKey, apiSecret, etc.) for secure input.
   * Credentials are stored separately via the credential service, never in plain config.
   * Not serialized — used for dynamic form generation in the settings UI.
   */
  readonly credentialSchema?: z.ZodObject<z.ZodRawShape>;
}
