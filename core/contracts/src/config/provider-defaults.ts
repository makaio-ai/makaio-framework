import { z } from 'zod';
import { AIModelSchema } from '../model/index.js';
import { ModelFilterModeSchema, ModelVisibilitySchema } from '../provider/visibility.js';
import { TimeoutConfigSchema } from '../timeout/index.js';

export { AIModelSchema };

/**
 * Stored protocol endpoint overrides persisted in provider config files.
 *
 * The stored file format allows sparse endpoint overrides because a provider
 * may only override one of the supported wire protocols.
 */
export const StoredProtocolEndpointsSchema = z
  .object({
    anthropic: z.string().url(),
    openai: z.string().url(),
  })
  .partial()
  .strict();

/**
 * Inferred type for stored protocol endpoint overrides.
 */
export type StoredProtocolEndpoints = z.infer<typeof StoredProtocolEndpointsSchema>;

/**
 * Provider defaults configuration without display/enabled fields.
 *
 * This lower-layer contract is shared by adapter config parsing and settings
 * RPC schemas, so it must remain outside adapter-core to avoid package cycles.
 */
export const ProviderDefaultsSchema = z
  .object({
    model: z.string().optional().describe('Model identifier (adapter-specific, e.g., sonnet, opus)'),

    timeouts: TimeoutConfigSchema.optional().describe('Timeout overrides for this provider'),

    cwd: z.string().optional().describe('Working directory for agent execution'),

    env: z.record(z.string(), z.string()).optional().describe('Environment variables to pass to agent execution'),

    providerSettings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Provider-specific configuration (non-credential settings only)'),
  })
  .strict();

/**
 * Configuration for a single adapter provider.
 *
 * Providers allow running multiple configurations of the same adapter
 * (e.g., different API keys, models, or runtime settings).
 */
// `safeExtend()` is the stock Zod 4 object API we rely on across contracts.
// It keeps the shared provider-defaults object as the base while adding the
// provider-only fields used by settings/config surfaces.
export const ProviderConfigSchema = ProviderDefaultsSchema.safeExtend({
  providerId: z.string().optional().describe('FK to the providers table (stable provider ID, e.g. "anthropic")'),

  definitionId: z.string().optional().describe('Provider definition identifier for schema lookup'),

  name: z.string().describe('Display name for UI'),

  baseUrl: z.string().url().optional().describe('Provider endpoint URL'),

  availableModels: z.array(AIModelSchema).optional().describe('Models from this provider'),

  modelFilterMode: ModelFilterModeSchema.optional().describe(
    'Controls default visibility for models without explicit overrides',
  ),

  modelVisibility: z
    .record(z.string(), ModelVisibilitySchema)
    .optional()
    .describe('Sparse per-model visibility overrides'),

  isDefault: z.boolean().default(false).describe('Whether this is the default provider for inheritance'),

  enabled: z.boolean().default(true).describe('Whether this provider is enabled (disabled providers are not loaded)'),
});

/**
 * Adapter configuration file schema.
 *
 * This schema defines the structure of user config files stored at:
 * `~/.makaio/adapters/<adapterName>/config.json`
 */
export const BaseAdapterConfigSchema = z.object({
  /**
   * Schema version identifier for forward compatibility.
   */
  $schema: z.literal('makaio/adapter-config/v2'),

  /**
   * Default settings applied to all providers.
   * Provider-specific settings override these defaults.
   */
  defaults: ProviderDefaultsSchema.optional(),

  /**
   * Named adapter providers with their configurations.
   * Each key is a provider identifier.
   * Defaults to empty object.
   */
  providers: z.record(z.string(), ProviderConfigSchema).default(() => ({})),
});
