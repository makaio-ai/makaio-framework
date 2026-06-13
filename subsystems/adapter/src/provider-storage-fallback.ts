import type { IMakaioBus } from '@makaio/bus-core';
import { ProviderDefinitionSchema } from '@makaio/contracts';
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
    (ctx) => {
      const provider = buildProviderRecordMap(getLoadedAdapters()).get(ctx.payload.id) ?? null;
      ctx.setResult({ provider });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listCleanup = bus.on(
    ProviderStorageSubjects.list,
    (ctx) => {
      ctx.setResult({ providers: [...buildProviderRecordMap(getLoadedAdapters()).values()] });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listByProtocolCleanup = bus.on(
    ProviderStorageSubjects.listByProtocol,
    (ctx) => {
      const providers = [...buildProviderRecordMap(getLoadedAdapters()).values()].filter(
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
 * @param adapters - Loaded adapter registry snapshot.
 * @returns Provider records keyed by stable provider definition ID.
 */
function buildProviderRecordMap(adapters: readonly LoadedAdapter[]): Map<string, ProviderRecord> {
  const providers = new Map<string, ProviderRecord>();

  for (const adapter of adapters) {
    for (const provider of adapter.providers) {
      const definition = ProviderDefinitionSchema.parse(provider.definition);
      if (providers.has(definition.id)) continue;
      providers.set(definition.id, {
        id: definition.id,
        packageName: provider.providerPackageName,
        name: definition.name,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.endpoints !== undefined ? { endpoints: definition.endpoints } : {}),
        ...(definition.defaultModel !== undefined ? { defaultModel: definition.defaultModel } : {}),
        ...(definition.fastModel !== undefined ? { fastModel: definition.fastModel } : {}),
        availableModels: definition.availableModels,
        defaultModelFilterMode: definition.defaultModelFilterMode ?? 'show-all',
        ...(definition.credentialEnvVars !== undefined ? { credentialEnvVars: definition.credentialEnvVars } : {}),
        enabled: true,
        createdAt: RUNTIME_RECORD_TIMESTAMP,
        updatedAt: RUNTIME_RECORD_TIMESTAMP,
      });
    }
  }

  return providers;
}
