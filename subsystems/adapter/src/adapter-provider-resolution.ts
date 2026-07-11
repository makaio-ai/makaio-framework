import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterProviderAuthSchema,
  assertAdapterAuthBindingMatchesMethod,
  type AdapterAuthBindingMethodDefinition,
  type AdapterProviderAuth,
  type AdapterProviderRef,
  type AuthMethodRef,
  type ClientAuthMethodDefinition,
  type ProviderAIModel,
  type ProviderAuthMethodDefinition,
  type ProviderDefinitionInput,
} from '@makaio/contracts';
import type { ClientDefinition } from '@makaio/contracts/client';
import { ExtensionSubjects } from '@makaio/kernel';
import { ModelRegistryProviderNotFoundError, ModelRegistrySubjects } from '@makaio/services-core/model-registry';
import type { z } from 'zod';
import type { LoadedAdapter, LoadedAdapterProvider } from './adapter-runtime-types.js';

export interface ProviderDefinitionCacheEntry {
  readonly packageName: string;
  readonly definition: ProviderDefinitionInput;
}

/** Optional runtime metadata used while resolving adapter provider paths. */
export interface ResolveProviderDefinitionsOptions {
  /** Adapter-level default config schema. */
  readonly adapterConfigSchema?: z.ZodObject<z.ZodRawShape>;
  /** Definitions for every client this adapter may execute. */
  readonly clientDefinitions?: readonly ClientDefinition[];
  /** Optional pre-built provider definition map. */
  readonly providerDefinitionCache?: Map<string, ProviderDefinitionCacheEntry>;
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
 * @param options - Adapter schema, runtime-client definitions, and optional provider cache.
 * @returns Resolved provider definitions with schemas applied.
 */
export async function resolveProviderDefinitions(
  bus: IMakaioBus,
  providerRefs: readonly AdapterProviderRef[],
  adapterName: string,
  options: ResolveProviderDefinitionsOptions = {},
): Promise<LoadedAdapterProvider[]> {
  let definitionMap = options.providerDefinitionCache;
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
      ...(ref.protocol !== undefined && { protocol: ref.protocol }),
      configSchema: ref.configSchema ?? options.adapterConfigSchema,
      ...(ref.auth !== undefined && {
        auth: resolveAdapterProviderAuth(ref.auth, entry.definition, options.clientDefinitions ?? [], adapterName),
      }),
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
 * Resolve one structurally valid declaration against authoritative method
 * definitions and compile the complete adapter-path source-hint scrub union.
 *
 * Every client declared by the adapter contributes source hints because the
 * selected runtime client may vary by auth method. This conservative union
 * always contains the actually executed client and prevents competitor ambient
 * credentials from re-entering through a client switch.
 * @param declaration - Adapter-auth declaration attached to the provider ref.
 * @param provider - Provider definition served by the ref.
 * @param clientDefinitions - Definitions for clients executable by the adapter.
 * @param adapterName - Adapter name used in declaration diagnostics.
 * @returns Validated declaration with definition-derived scrub variables.
 */
function resolveAdapterProviderAuth(
  declaration: AdapterProviderAuth,
  provider: ProviderDefinitionInput,
  clientDefinitions: readonly ClientDefinition[],
  adapterName: string,
): AdapterProviderAuth {
  const auth = AdapterProviderAuthSchema.parse(declaration);
  const scrubEnvVars = new Set(auth.scrubEnvVars);

  collectSourceHintVariables(provider.authMethods ?? [], scrubEnvVars);
  for (const client of clientDefinitions) {
    collectSourceHintVariables(client.authMethods, scrubEnvVars);
  }

  for (const binding of auth.bindings) {
    const method = resolveBindingMethod(binding.method, provider, clientDefinitions, adapterName);
    assertAdapterAuthBindingMatchesMethod(binding, method);
  }

  return AdapterProviderAuthSchema.parse({
    bindings: auth.bindings,
    scrubEnvVars: [...scrubEnvVars],
  });
}

/**
 * Resolve one owner-qualified binding method from provider/client definitions.
 * @param methodRef - Binding method reference.
 * @param provider - Provider definition served by the adapter path.
 * @param clientDefinitions - Client definitions declared by the adapter.
 * @param adapterName - Adapter name used in declaration diagnostics.
 * @returns Authoritative method definition.
 */
function resolveBindingMethod(
  methodRef: AuthMethodRef,
  provider: ProviderDefinitionInput,
  clientDefinitions: readonly ClientDefinition[],
  adapterName: string,
): AdapterAuthBindingMethodDefinition {
  if (methodRef.owner === 'provider') {
    if (methodRef.providerDefinitionId !== provider.id) {
      throw new Error(
        `Adapter "${adapterName}" binds provider method "${methodRef.methodId}" to definition ` +
          `"${methodRef.providerDefinitionId}" while serving "${provider.id}".`,
      );
    }
    const method = (provider.authMethods ?? []).find(({ id }) => id === methodRef.methodId);
    if (method === undefined) {
      throw new Error(
        `Adapter "${adapterName}" binds undeclared provider auth method "${provider.id}/${methodRef.methodId}".`,
      );
    }
    return method;
  }

  const client = clientDefinitions.find(({ id }) => id === methodRef.clientId);
  if (client === undefined) {
    throw new Error(
      `Adapter "${adapterName}" binds authentication method "${methodRef.clientId}/${methodRef.methodId}" ` +
        'without declaring that client.',
    );
  }
  const method = client.authMethods.find(({ id }) => id === methodRef.methodId);
  if (method === undefined) {
    throw new Error(
      `Adapter "${adapterName}" binds undeclared client auth method "${methodRef.clientId}/${methodRef.methodId}".`,
    );
  }
  return method;
}

/**
 * Add environment source hints from explicit auth methods to one scrub set.
 * @param methods - Provider- or client-owned method definitions.
 * @param scrubEnvVars - Mutable declaration-local scrub union.
 */
function collectSourceHintVariables(
  methods: readonly (ProviderAuthMethodDefinition | ClientAuthMethodDefinition)[],
  scrubEnvVars: Set<string>,
): void {
  for (const method of methods) {
    if (method.mode !== 'explicit') continue;
    for (const field of method.fields) {
      for (const hint of field.sourceHints) scrubEnvVars.add(hint.variable);
    }
  }
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
  const providers = await resolveProviderDefinitions(bus, adapter.providerRefs, adapter.name, {
    ...(adapter.providerConfigSchema !== undefined && { adapterConfigSchema: adapter.providerConfigSchema }),
    ...(adapter.clientDefinitions !== undefined && { clientDefinitions: adapter.clientDefinitions }),
    ...(providerDefinitionCache !== undefined && { providerDefinitionCache }),
  });
  return populateProviderModels(bus, adapter.name, providers, providerModelCache);
}
