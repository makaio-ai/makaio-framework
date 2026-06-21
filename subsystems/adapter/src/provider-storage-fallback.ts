import type { IMakaioBus } from '@makaio/bus-core';
import { ProviderDefinitionSchema, type ProviderDefinitionInput } from '@makaio/contracts';
import { ExtensionSubjects } from '@makaio/kernel';
import { ProviderStorageSubjects, type ProviderRecord } from '@makaio/services-core/settings/storage';
import type { LoadedAdapter } from './adapter-runtime-types.js';

const FALLBACK_HANDLER_PRIORITY = -100;
const RUNTIME_RECORD_TIMESTAMP = 0;

/**
 * Registers provider-storage reads backed by loaded adapter provider definitions.
 *
 * Product hosts may register database-backed provider storage at the default
 * priority. These handlers deliberately run later so framework-only runtimes
 * still have a provider-definition read model without taking over product
 * storage.
 * @param bus - Bus used to register provider-storage handlers.
 * @param getLoadedAdapters - Lazy accessor for the live loaded-adapter registry.
 * @returns Cleanup function unregistering all handlers.
 */
export function registerProviderStorageFallbackHandlers(
  bus: IMakaioBus,
  getLoadedAdapters: () => readonly LoadedAdapter[],
): () => void {
  const getCleanup = bus.on(
    ProviderStorageSubjects.get,
    async (ctx) => {
      const provider = (await buildProviderRecordMap(bus, getLoadedAdapters())).get(ctx.payload.id) ?? null;
      ctx.setResult({ provider });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listCleanup = bus.on(
    ProviderStorageSubjects.list,
    async (ctx) => {
      ctx.setResult({ providers: [...(await buildProviderRecordMap(bus, getLoadedAdapters())).values()] });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listByProtocolCleanup = bus.on(
    ProviderStorageSubjects.listByProtocol,
    async (ctx) => {
      const providers = [...(await buildProviderRecordMap(bus, getLoadedAdapters())).values()].filter(
        (provider) => provider.endpoints !== undefined && ctx.payload.protocol in provider.endpoints,
      );
      ctx.setResult({ providers });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );

  return () => {
    getCleanup();
    listCleanup();
    listByProtocolCleanup();
  };
}

/**
 * Build provider records from currently loaded adapter definitions.
 * @param bus - Bus used to read the current extension contribution catalog.
 * @param adapters - Loaded adapter registry snapshot.
 * @returns Provider records keyed by stable provider definition ID.
 */
async function buildProviderRecordMap(
  bus: IMakaioBus,
  adapters: readonly LoadedAdapter[],
): Promise<Map<string, ProviderRecord>> {
  const providers = new Map<string, ProviderRecord>();
  const declaredProviderIds = new Set<string>();

  for (const adapter of adapters) {
    for (const id of adapter.providerDefinitionIds) {
      declaredProviderIds.add(id);
    }
    for (const provider of adapter.providers) {
      addProviderRecord(providers, provider.providerPackageName, provider.definition);
    }
  }

  const unresolvedProviderIds = [...declaredProviderIds].filter((id) => !providers.has(id));
  if (unresolvedProviderIds.length > 0) {
    const catalog = await bus.request(ExtensionSubjects.contributions.catalog, {});
    for (const provider of catalog.providers) {
      if (unresolvedProviderIds.includes(provider.definition.id)) {
        addProviderRecord(providers, provider.packageName, provider.definition);
      }
    }
  }

  return providers;
}

/**
 * Add one provider definition to the provider-storage read model.
 * @param providers - Accumulator keyed by provider ID.
 * @param packageName - Extension package that contributed the provider.
 * @param input - Provider definition to normalize into a storage record.
 */
function addProviderRecord(
  providers: Map<string, ProviderRecord>,
  packageName: string,
  input: ProviderDefinitionInput,
): void {
  const definition = ProviderDefinitionSchema.parse(input);
  if (providers.has(definition.id)) return;
  providers.set(definition.id, {
    id: definition.id,
    packageName,
    name: definition.name,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.endpoints !== undefined ? { endpoints: definition.endpoints } : {}),
    ...(definition.defaultModel !== undefined ? { defaultModel: definition.defaultModel } : {}),
    ...(definition.fastModel !== undefined ? { fastModel: definition.fastModel } : {}),
    availableModels: definition.availableModels,
    defaultModelFilterMode: definition.defaultModelFilterMode ?? 'show-all',
    ...(definition.credentialEnvVars !== undefined ? { credentialEnvVars: definition.credentialEnvVars } : {}),
    ...(definition.capabilities !== undefined ? { capabilities: definition.capabilities } : {}),
    enabled: true,
    createdAt: RUNTIME_RECORD_TIMESTAMP,
    updatedAt: RUNTIME_RECORD_TIMESTAMP,
  });
}
