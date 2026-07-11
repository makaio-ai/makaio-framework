import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ProviderConfigAuthSchema } from '@makaio/contracts/auth';
import { AdapterFileSchema } from '@makaio/contracts/config';
import { ModelFilterModeSchema, ProviderDefinitionSchema } from '@makaio/contracts/provider';
import { CanonicalProviderConfigPatchSchema, CreateCanonicalProviderConfigInputSchema } from './write-types.js';
import {
  AdapterFileConfigSchema,
  AdapterRuntimeSnapshotResolutionSchema,
  BindingRecordSchema,
  CompatibleAuthOptionSchema,
  EffectiveAdapterSchema,
  HelpLinkSchema,
  ProviderConfigFileRecordSchema,
  ProviderRuntimeSnapshotSchema,
} from './runtime-schemas.js';

/** Empty object schema used by request/response subjects with no payload fields. */
const EmptyObjectSchema = z.object({}).strict();

/**
 * Adapter-subsystem bus schemas.
 *
 * Each key becomes a subject identifier under the `adapterSubsystem.` namespace.
 */
export const AdapterSubsystemSchemas = {
  /**
   * Get one adapter config by adapter name.
   */
  getAdapterConfig: {
    request: z
      .object({
        name: z.string(),
      })
      .strict(),
    response: z
      .object({
        config: AdapterFileConfigSchema.nullable(),
      })
      .strict(),
  },

  /**
   * List all adapter configs.
   */
  listAdapterConfigs: {
    request: EmptyObjectSchema,
    response: z
      .object({
        configs: z.array(AdapterFileConfigSchema),
      })
      .strict(),
  },

  /**
   * Get one provider config by ID.
   */
  getProviderConfig: {
    request: z
      .object({
        id: z.string(),
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema.nullable(),
      })
      .strict(),
  },

  /**
   * List provider configs, optionally filtering by enabled state.
   */
  listProviderConfigs: {
    request: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict(),
    response: z
      .object({
        configs: z.array(ProviderConfigFileRecordSchema),
      })
      .strict(),
  },

  /**
   * List provider configs for a given provider definition.
   */
  listProviderConfigsByDefinition: {
    request: z
      .object({
        definitionId: z.string(),
      })
      .strict(),
    response: z
      .object({
        configs: z.array(ProviderConfigFileRecordSchema),
      })
      .strict(),
  },

  /**
   * List bindings for an adapter.
   */
  listBindings: {
    request: z
      .object({
        adapterName: z.string(),
      })
      .strict(),
    response: z
      .object({
        bindings: z.array(BindingRecordSchema),
      })
      .strict(),
  },

  /**
   * List bindings for a provider config.
   */
  listBindingsByConfig: {
    request: z
      .object({
        providerConfigId: z.string(),
      })
      .strict(),
    response: z
      .object({
        bindings: z.array(BindingRecordSchema),
      })
      .strict(),
  },

  /**
   * Get the default binding for an adapter.
   */
  getDefaultBinding: {
    request: z
      .object({
        adapterName: z.string(),
      })
      .strict(),
    response: z
      .object({
        binding: BindingRecordSchema.nullable(),
      })
      .strict(),
  },

  /**
   * Find the provider config bound to a specific adapter for a definition.
   */
  findConfigForDefinitionAndAdapter: {
    request: z
      .object({
        definitionId: z.string(),
        adapterName: z.string(),
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema.nullable(),
      })
      .strict(),
  },

  /**
   * Resolve a safe config, refs-only context, and provider definition from one
   * captured runtime snapshot.
   */
  resolveProviderRuntimeSnapshot: {
    request: z
      .object({
        providerConfigId: z.string(),
      })
      .strict(),
    response: z
      .object({
        snapshot: ProviderRuntimeSnapshotSchema.nullable(),
      })
      .strict(),
  },

  /**
   * Resolve provider state, exact adapter auth declarations, and runtime import
   * paths from one adapter-subsystem read.
   */
  resolveAdapterRuntimeSnapshot: {
    request: z
      .object({
        adapterName: z.string().trim().min(1),
        providerConfigId: z.string().trim().min(1),
      })
      .strict(),
    response: AdapterRuntimeSnapshotResolutionSchema,
  },

  /**
   * List effective adapters.
   */
  listAdapters: {
    request: EmptyObjectSchema,
    response: z
      .object({
        adapters: z.array(EffectiveAdapterSchema),
      })
      .strict(),
  },

  /**
   * Get provider definitions contributed by a specific adapter.
   *
   * Returns the full provider definition array for the named adapter, including
   * the registry-populated `availableModels` set at boot time.
   */
  getProviderDefinitionsByAdapter: {
    request: z
      .object({
        /** Adapter name whose provider definitions to fetch. */
        adapterName: z.string(),
      })
      .strict(),
    response: z
      .object({
        /** Provider definitions contributed by the adapter. */
        definitions: z.array(ProviderDefinitionSchema),
      })
      .strict(),
  },

  /**
   * List normalized authentication methods deliverable by loaded adapters for
   * one provider definition.
   */
  listCompatibleAuthOptions: {
    request: z
      .object({
        definitionId: z.string().trim().min(1),
      })
      .strict(),
    response: z
      .object({
        options: z.array(CompatibleAuthOptionSchema),
      })
      .strict(),
  },

  /**
   * Create a provider config.
   */
  createProviderConfig: {
    request: CreateCanonicalProviderConfigInputSchema,
    response: z
      .object({
        config: ProviderConfigFileRecordSchema,
      })
      .strict(),
  },

  /**
   * Update a provider config.
   */
  updateProviderConfig: {
    request: z
      .object({
        id: z.string(),
        patch: CanonicalProviderConfigPatchSchema,
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema,
      })
      .strict(),
  },

  /** Replace the complete authentication selection for one provider config. */
  setProviderConfigAuth: {
    request: z
      .object({
        id: z.string(),
        auth: ProviderConfigAuthSchema,
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema,
      })
      .strict(),
  },

  /**
   * Delete a provider config.
   */
  deleteProviderConfig: {
    request: z
      .object({
        id: z.string(),
      })
      .strict(),
    response: z
      .object({
        deleted: z.boolean(),
      })
      .strict(),
  },

  /**
   * Set the default provider config for its definition.
   */
  setDefaultProviderConfig: {
    request: z
      .object({
        id: z.string(),
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema,
      })
      .strict(),
  },

  /**
   * Set the model filter mode for a provider config.
   */
  setModelFilterMode: {
    request: z
      .object({
        id: z.string(),
        modelFilterMode: ModelFilterModeSchema,
        preferredModel: z.string().optional(),
      })
      .strict(),
    response: z
      .object({
        config: ProviderConfigFileRecordSchema,
      })
      .strict(),
  },

  /**
   * Set adapter config fields.
   */
  setAdapterConfig: {
    request: z
      .object({
        name: z.string(),
        patch: z
          .object({
            displayName: z.string().optional(),
            description: z.string().optional(),
            helpLinks: z.array(HelpLinkSchema).optional(),
            instructions: z.string().optional(),
            clientId: z.string().optional(),
            protocol: z.string().optional(),
            providerDefinitionIds: z.array(z.string()).optional(),
            settings: AdapterFileSchema.shape.settings,
            enabled: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    response: z
      .object({
        config: AdapterFileConfigSchema,
      })
      .strict(),
  },

  /**
   * Enable or disable an adapter config.
   */
  setAdapterEnabled: {
    request: z
      .object({
        name: z.string(),
        enabled: z.boolean(),
      })
      .strict(),
    response: z
      .object({
        success: z.boolean(),
      })
      .strict(),
  },

  /**
   * Bind a provider config to an adapter.
   */
  bind: {
    request: z
      .object({
        adapterName: z.string(),
        providerConfigId: z.string(),
      })
      .strict(),
    response: z
      .object({
        binding: BindingRecordSchema,
      })
      .strict(),
  },

  /**
   * Unbind a provider config from an adapter.
   */
  unbind: {
    request: z
      .object({
        adapterName: z.string(),
        providerConfigId: z.string(),
      })
      .strict(),
    response: EmptyObjectSchema,
  },

  /**
   * Set the default binding for an adapter.
   */
  setDefaultBinding: {
    request: z
      .object({
        adapterName: z.string(),
        providerConfigId: z.string(),
      })
      .strict(),
    response: EmptyObjectSchema,
  },

  /**
   * Ensure the subsystem is ready for grain-constrained consumers.
   */
  ensureReady: {
    request: EmptyObjectSchema,
    response: z
      .object({
        ready: z.literal(true),
      })
      .strict(),
  },

  /**
   * Provider config lifecycle events.
   */
  'providerConfig.created': ProviderConfigFileRecordSchema,
  'providerConfig.updated': ProviderConfigFileRecordSchema,
  'providerConfig.deleted': z
    .object({
      id: z.string(),
    })
    .strict(),
  'providerConfig.defaultChanged': z
    .object({
      definitionId: z.string(),
      configId: z.string().nullable(),
    })
    .strict(),

  /**
   * Binding lifecycle events.
   */
  'binding.created': BindingRecordSchema,
  'binding.deleted': z
    .object({
      adapterName: z.string(),
      providerConfigId: z.string(),
    })
    .strict(),
  'binding.defaultChanged': z
    .object({
      adapterName: z.string(),
      providerConfigId: z.string(),
    })
    .strict(),

  /**
   * Readiness observability event (fire-and-forget, no replay guarantee).
   *
   * Listeners registered after the subsystem emits this event will miss it.
   * Use `ensureReady` (request/response) for reliable coordination.
   */
  ready: EmptyObjectSchema,

  /**
   * Emitted once per adapter after the adapter-subsystem service processes a
   * newly-active adapter package.
   *
   * Replaces the retired batch `adaptersRegistered` event. The model registry
   * and other subscribers react per-adapter and debounce refreshes as needed.
   *
   * Fire-and-forget; no replay guarantee.
   */
  'adapter.registered': z
    .object({
      adapterName: z.string(),
      displayName: z.string(),
      packageName: z.string(),
      enabled: z.boolean(),
      initialized: z.boolean(),
      providerDefinitionIds: z.array(z.string()),
    })
    .strict(),
} satisfies SchemaRecord;
