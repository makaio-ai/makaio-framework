import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { AIModelSchema, ProviderAIModelSchema } from '@makaio/contracts';

/**
 * Schema for a lab entry in the v2 registry.
 *
 * A lab is the entity that created the models (e.g., Anthropic, OpenAI, Google).
 * Models under a lab carry the canonical definition — name, context window,
 * knowledge cutoff, reasoning levels, and metadata.
 */
const LabRegistryEntrySchema = z.object({
  /** Human-readable lab name (e.g., 'Anthropic', 'OpenAI'). */
  name: z.string(),

  /**
   * Canonical model definitions published by this lab.
   * Each entry is a full {@link AIModelSchema} descriptor.
   */
  models: z.array(AIModelSchema),
});

/**
 * Provider-specific model override schema.
 *
 * Provider entries may override serving-specific model fields, but identity
 * remains owned by the lab model reference and is resolved at merge time.
 */
export const ProviderModelOverrideSchema = AIModelSchema.partial().extend({
  /**
   * Canonical lab model referenced by this provider-specific model ID.
   *
   * Omit when the provider model ID is already the canonical lab model name.
   * Aggregating providers such as OpenRouter use provider-native IDs as keys
   * and set this field to the canonical model whose metadata should be merged.
   */
  canonicalModel: z.string().optional(),
  /** Provider overrides cannot rename the referenced lab model. */
  name: z.never({ error: 'Provider model overrides cannot include identity fields' }).optional(),
  /** Provider overrides cannot change the referenced lab id. */
  labId: z.never({ error: 'Provider model overrides cannot include identity fields' }).optional(),
});

/** Inferred type for provider-specific model overrides. */
export type ProviderModelOverride = z.infer<typeof ProviderModelOverrideSchema>;

/**
 * Schema for a provider entry in the v2 registry.
 *
 * A provider is the entity serving the models (e.g., Anthropic direct, Z.AI, OpenRouter).
 * Provider model entries carry only the fields that differ from the lab definition
 * (e.g., provider-specific pricing, capabilities). `name` and `labId` are always
 * inherited from the lab and are therefore omitted here.
 */
const ProviderRegistryEntrySchema = z.object({
  /** Human-readable provider name (e.g., 'Anthropic', 'Z.AI'). */
  name: z.string(),

  /**
   * Provider-specific model overrides keyed by provider model ID.
   *
   * Values are partial {@link AIModelSchema} objects — only fields that diverge
   * from the lab definition need to be present. When the provider model ID is
   * not the canonical lab model name, `canonicalModel` points at the lab model
   * to merge. `name` and `labId` are omitted because they are resolved from the
   * provider key and lab entry at merge time.
   */
  models: z.record(z.string(), ProviderModelOverrideSchema),
});

/**
 * Schema for the complete v2 model registry.
 *
 * The v2 format separates lab definitions (canonical model metadata) from
 * provider overrides (serving-specific fields like pricing and capabilities).
 * This allows a single lab model to be served by multiple providers with
 * minimal duplication.
 */
export const ModelRegistrySchema = z
  .object({
    /**
     * Schema version identifier — must be `'makaio/model-registry/v2'`.
     */
    $schema: z.literal('makaio/model-registry/v2'),

    /**
     * ISO 8601 timestamp of last registry update.
     */
    updatedAt: z.string().datetime(),

    /**
     * Map of lab identifiers to their canonical model definitions.
     * Key is the lab id (e.g., 'anthropic', 'openai', 'google', 'meta').
     */
    labs: z.record(z.string(), LabRegistryEntrySchema),

    /**
     * Map of provider identifiers to their serving-specific model overrides.
     * Key is the provider id (e.g., 'anthropic', 'z-ai', 'openrouter').
     */
    providers: z.record(z.string(), ProviderRegistryEntrySchema),
  })
  .superRefine((registry, ctx) => {
    const labModelOwners = new Map<string, string>();

    for (const [labId, lab] of Object.entries(registry.labs)) {
      for (const [modelIndex, model] of lab.models.entries()) {
        if (model.labId !== labId) {
          ctx.addIssue({
            code: 'custom',
            path: ['labs', labId, 'models', modelIndex, 'labId'],
            message: `Lab model labId "${model.labId}" does not match lab key "${labId}"`,
          });
        }

        const existingLabId = labModelOwners.get(model.name);
        if (existingLabId !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['labs', labId, 'models', modelIndex, 'name'],
            message: `Duplicate canonical model name "${model.name}" appears in labs "${existingLabId}" and "${labId}"`,
          });
          continue;
        }

        labModelOwners.set(model.name, labId);
      }
    }

    for (const [providerId, provider] of Object.entries(registry.providers)) {
      const canonicalOwners = new Map<string, string>();
      for (const [providerModelId, override] of Object.entries(provider.models)) {
        const canonicalModel = override.canonicalModel ?? providerModelId;
        const existingProviderModelId = canonicalOwners.get(canonicalModel);
        if (existingProviderModelId !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['providers', providerId, 'models', providerModelId, 'canonicalModel'],
            message:
              `Duplicate canonical model reference "${canonicalModel}" for provider "${providerId}"` +
              ` via models "${existingProviderModelId}" and "${providerModelId}"`,
          });
          continue;
        }

        canonicalOwners.set(canonicalModel, providerModelId);

        if (!labModelOwners.has(canonicalModel)) {
          ctx.addIssue({
            code: 'custom',
            path: ['providers', providerId, 'models', providerModelId],
            message:
              `Unknown provider model reference "${canonicalModel}" for provider "${providerId}"` +
              (canonicalModel === providerModelId ? '' : ` model "${providerModelId}"`),
          });
        }
      }
    }
  });

/**
 * Inferred type for the v2 model registry.
 */
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;

/**
 * Model registry bus schemas.
 *
 * Subjects for model-registry-related bus communication.
 * Each key becomes a subject identifier as: `modelRegistry.{key}`
 *
 * **Bus subjects:**
 * - `modelRegistry.getForProvider` — Resolve a single model for a provider
 * - `modelRegistry.getLabModels` — List all canonical models for a lab
 * - `modelRegistry.getProviderModels` — List all models available from a provider
 * - `modelRegistry.refresh` — Force refresh from remote registry
 * - `modelRegistry.changed` — Broadcast that the in-memory registry changed
 * @example Get models for a provider
 * ```typescript
 * const result = await bus.request(ModelRegistrySubjects.getProviderModels, {
 *   providerId: 'anthropic',
 * });
 * ```
 * @example Force refresh from remote
 * ```typescript
 * await bus.request(ModelRegistrySubjects.refresh, {});
 * ```
 */
export const ModelRegistrySchemas = {
  /**
   * Resolve a single model by provider and provider-native model ID.
   *
   * Returns the merged model descriptor (lab definition + provider overrides),
   * or `undefined` if the model is not found for the given provider.
   */
  getForProvider: {
    request: z.object({
      /** Provider identifier (e.g., 'anthropic', 'z-ai'). */
      providerId: z.string(),
      /** Model ID as used by the provider (e.g., 'anthropic/claude-sonnet-4-6'). */
      model: z.string(),
    }),
    response: z.object({
      /** Merged model descriptor, or `undefined` if not found. */
      model: ProviderAIModelSchema.optional(),
    }),
  },

  /**
   * List all canonical model definitions published by a lab.
   *
   * Returns the full lab model array without any provider-specific overrides.
   */
  getLabModels: {
    request: z.object({
      /** Lab identifier (e.g., 'anthropic', 'openai', 'google', 'meta'). */
      labId: z.string(),
    }),
    response: z.object({
      /** Canonical model descriptors for the lab. */
      models: z.array(AIModelSchema),
    }),
  },

  /**
   * List all models available from a provider (merged with lab definitions).
   *
   * Returns the full merged model list for the provider — lab defaults with
   * provider-specific overrides applied.
   */
  getProviderModels: {
    request: z.object({
      /** Provider identifier (e.g., 'anthropic', 'z-ai', 'openrouter'). */
      providerId: z.string(),
    }),
    response: z.object({
      /** Merged model descriptors for the provider. */
      models: z.array(ProviderAIModelSchema),
    }),
  },

  /**
   * Force refresh of the model registry from remote source.
   * Fetches latest registry and updates cache.
   */
  refresh: {
    request: z.object({}),
    response: z.object({
      /** Whether refresh was successful. */
      success: z.boolean(),

      /** Error message if refresh failed. */
      error: z.string().optional(),
    }),
  },

  /**
   * Batch-check model availability across multiple providers in a single RPC.
   *
   * Accepts an array of provider IDs and a canonical lab model name. Returns a map of
   * `providerId → resolved ProviderAIModel` containing only the providers
   * that have the model. Providers absent from the registry or that do not
   * list the model are omitted from the result.
   *
   * Use this subject instead of calling `getForProvider` in a loop — it
   * collapses N sequential RPCs into a single bus request.
   * @example
   * ```typescript
   * const { matches } = await bus.request(ModelRegistrySubjects.checkModelInProviders, {
   *   providerIds: ['anthropic', 'openrouter', 'z-ai'],
   *   model: 'claude-sonnet-4-6',
   * });
   * // matches: { anthropic: AIModel, openrouter: AIModel }
   * ```
   */
  checkModelInProviders: {
    request: z.object({
      /** Provider identifiers to check (e.g., ['anthropic', 'openrouter']). */
      providerIds: z.array(z.string()),
      /** Canonical lab model name to look up across the given providers. */
      model: z.string(),
    }),
    response: z.object({
      /**
       * Map of providerId → resolved ProviderAIModel.
       * Only providers that have the model are included.
       */
      matches: z.record(z.string(), ProviderAIModelSchema),
    }),
  },

  /**
   * Broadcast that the registry has been refreshed and committed.
   *
   * Fire-and-forget event used by consumers that need to rescan registry-backed
   * capabilities after a successful refresh.
   */
  changed: z.object({}),
} satisfies SchemaRecord;

/**
 * Type for modelRegistry.getForProvider request.
 */
export type ModelRegistryGetForProviderRequest = z.infer<typeof ModelRegistrySchemas.getForProvider.request>;

/**
 * Type for modelRegistry.getForProvider response.
 */
export type ModelRegistryGetForProviderResponse = z.infer<typeof ModelRegistrySchemas.getForProvider.response>;

/**
 * Type for modelRegistry.getLabModels request.
 */
export type ModelRegistryGetLabModelsRequest = z.infer<typeof ModelRegistrySchemas.getLabModels.request>;

/**
 * Type for modelRegistry.getLabModels response.
 */
export type ModelRegistryGetLabModelsResponse = z.infer<typeof ModelRegistrySchemas.getLabModels.response>;

/**
 * Type for modelRegistry.getProviderModels request.
 */
export type ModelRegistryGetProviderModelsRequest = z.infer<typeof ModelRegistrySchemas.getProviderModels.request>;

/**
 * Type for modelRegistry.getProviderModels response.
 */
export type ModelRegistryGetProviderModelsResponse = z.infer<typeof ModelRegistrySchemas.getProviderModels.response>;

/**
 * Type for modelRegistry.refresh request.
 */
export type ModelRegistryRefreshRequest = z.infer<typeof ModelRegistrySchemas.refresh.request>;

/**
 * Type for modelRegistry.refresh response.
 */
export type ModelRegistryRefreshResponse = z.infer<typeof ModelRegistrySchemas.refresh.response>;

/**
 * Type for modelRegistry.checkModelInProviders request.
 */
export type ModelRegistryCheckModelInProvidersRequest = z.infer<
  typeof ModelRegistrySchemas.checkModelInProviders.request
>;

/**
 * Type for modelRegistry.checkModelInProviders response.
 */
export type ModelRegistryCheckModelInProvidersResponse = z.infer<
  typeof ModelRegistrySchemas.checkModelInProviders.response
>;
