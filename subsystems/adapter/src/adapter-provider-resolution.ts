import type { IMakaioBus } from '@makaio/bus-core';
import type { AdapterProviderRef, ProviderAIModel, ProviderDefinitionInput } from '@makaio/contracts';
import { ExtensionSubjects } from '@makaio/kernel';
import { ModelRegistryProviderNotFoundError, ModelRegistrySubjects } from '@makaio/services-core/model-registry';
import type { z } from 'zod';
import type { LoadedAdapter, LoadedAdapterProvider } from './adapter-runtime-types.js';

export interface ProviderDefinitionCacheEntry {
  readonly packageName: string;
  readonly definition: ProviderDefinitionInput;
}

/**
 * Clone model descriptors before injecting them into loaded adapter metadata.
 * @param models - Source models from either the registry or static provider definition.
 * @returns Defensive clone safe for runtime mutation by downstream consumers.
 */
function cloneProviderModels(models: readonly ProviderAIModel[]): ProviderAIModel[] {
  return models.map((model) => ({ ...model }));
}

/**
 * Detect a registry miss through the bus request wrapper.
 * @param error - Error thrown by the model-registry request.
 * @returns True when the registry handled the request but does not own the provider.
 */
function isRegistryProviderMiss(error: unknown): boolean {
  if (error instanceof ModelRegistryProviderNotFoundError) return true;
  if (typeof error !== 'object' || error === null) return false;

  const record = error as { readonly name?: unknown; readonly providerId?: unknown; readonly cause?: unknown };
  if (record.name === 'ModelRegistryProviderNotFoundError' && typeof record.providerId === 'string') return true;
  if (
    error instanceof Error &&
    /^Request to "getProviderModels" failed: Provider ".+" is not present in the model registry$/.test(error.message)
  ) {
    return true;
  }
  if (error instanceof Error && /^Provider ".+" is not present in the model registry$/.test(error.message)) return true;
  return isRegistryProviderMiss(record.cause);
}

/**
 * Resolve adapter-declared provider IDs to full provider definitions.
 * @param bus - Bus used to query the contributions catalog.
 * @param providerRefs - Adapter-declared provider references to resolve.
 * @param adapterName - Adapter name used for error messages.
 * @param adapterConfigSchema - Adapter-level default config schema.
 * @param adapterCredentialSchema - Adapter-level default credential schema.
 * @param providerDefinitionCache - Optional pre-built definition map.
 * @returns Resolved provider definitions with schemas applied.
 */
export async function resolveProviderDefinitions(
  bus: IMakaioBus,
  providerRefs: readonly AdapterProviderRef[],
  adapterName: string,
  adapterConfigSchema?: z.ZodObject<z.ZodRawShape>,
  adapterCredentialSchema?: z.ZodObject<z.ZodRawShape>,
  providerDefinitionCache?: Map<string, ProviderDefinitionCacheEntry>,
): Promise<LoadedAdapterProvider[]> {
  let definitionMap = providerDefinitionCache;
  if (!definitionMap) {
    definitionMap = new Map<string, ProviderDefinitionCacheEntry>();
    const catalog = await bus.request(ExtensionSubjects.contributions.catalog, {});
    for (const entry of catalog.providers) {
      definitionMap.set(entry.definition.id, entry);
    }
  }

  const resolved: LoadedAdapterProvider[] = [];
  const missing: string[] = [];

  for (const ref of providerRefs) {
    const entry = definitionMap.get(ref.definitionId);
    if (!entry) {
      missing.push(ref.definitionId);
      continue;
    }
    resolved.push({
      definition: entry.definition,
      providerPackageName: entry.packageName,
      configSchema: ref.configSchema ?? adapterConfigSchema,
      credentialSchema: ref.credentialSchema ?? adapterCredentialSchema,
    });
  }

  if (missing.length > 0) {
    console.warn(
      `[AdapterContributionProcessor] Adapter "${adapterName}" declares providers [${missing.join(', ')}] ` +
        `but no active extension registers them. These providers will be unavailable until their extensions are loaded.`,
    );
  }

  return resolved;
}

/**
 * Populate available models on resolved provider definitions.
 * @param bus - Bus used to query the model registry.
 * @param adapterName - Adapter name used for diagnostics.
 * @param providers - Provider definitions resolved from the contribution catalog.
 * @param providerModelCache - Per-batch model cache.
 * @returns Provider definitions with model catalogs applied.
 */
export async function populateProviderModels(
  bus: IMakaioBus,
  adapterName: string,
  providers: readonly LoadedAdapterProvider[],
  providerModelCache: Map<string, ProviderAIModel[]>,
): Promise<LoadedAdapterProvider[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const providerId = provider.definition.id;
      try {
        let models = providerModelCache.get(providerId);
        if (models === undefined) {
          const result = await bus.requestOptional(ModelRegistrySubjects.getProviderModels, { providerId });
          models = result.handled ? result.data.models : (provider.definition.availableModels ?? []);
          providerModelCache.set(providerId, models);
        }
        return {
          ...provider,
          definition: {
            ...provider.definition,
            availableModels: cloneProviderModels(models),
          },
        };
      } catch (error) {
        if (!isRegistryProviderMiss(error)) {
          console.warn(
            `[AdapterContributionProcessor] Failed to populate available models for provider "${providerId}" on adapter "${adapterName}". Falling back to declared provider models.`,
            error,
          );
        }
        return {
          ...provider,
          definition: {
            ...provider.definition,
            availableModels: cloneProviderModels(provider.definition.availableModels ?? []),
          },
        };
      }
    }),
  );
}

/**
 * Resolve a loaded adapter's provider refs against the current active extension catalog.
 * @param adapter - Loaded adapter whose providers should be refreshed.
 * @param bus - Bus used to query extension and model registry subjects.
 * @param providerModelCache - Per-batch model cache.
 * @param providerDefinitionCache - Optional pre-built definition map that may include the currently activating package.
 * @returns Fresh provider definitions for the adapter.
 */
export async function resolveLoadedAdapterProviders(
  adapter: LoadedAdapter,
  bus: IMakaioBus,
  providerModelCache: Map<string, ProviderAIModel[]>,
  providerDefinitionCache?: Map<string, ProviderDefinitionCacheEntry>,
): Promise<LoadedAdapterProvider[]> {
  const providers = await resolveProviderDefinitions(
    bus,
    adapter.providerRefs,
    adapter.name,
    adapter.providerConfigSchema,
    adapter.providerCredentialSchema,
    providerDefinitionCache,
  );
  return populateProviderModels(bus, adapter.name, providers, providerModelCache);
}
