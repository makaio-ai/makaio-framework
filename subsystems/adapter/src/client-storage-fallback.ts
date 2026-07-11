import type { IMakaioBus } from '@makaio/bus-core';
import { ClientDefinitionSchema, type ClientDefinition } from '@makaio/contracts';
import { ExtensionSubjects } from '@makaio/kernel';
import { ClientStorageSubjects, type ClientRecord } from '@makaio/services-core/settings/storage';
import type { LoadedAdapter } from './adapter-runtime-types.js';

const FALLBACK_HANDLER_PRIORITY = -100;
const RUNTIME_RECORD_TIMESTAMP = 0;

/** Minimal loaded-adapter surface needed to discover client references. */
type LoadedAdapterClientRefs = Pick<LoadedAdapter, 'clients'>;

/**
 * Register client-storage reads backed by the active extension contribution catalog.
 *
 * Product hosts may provide database-backed storage at the default priority.
 * These lower-priority handlers exist for framework-only runtimes, where
 * normalized client-owned auth still requires definition-backed validation.
 * @param bus - Bus used for storage handlers and catalog reads.
 * @param getLoadedAdapters - Lazy accessor for loaded adapter client refs.
 * @returns Cleanup function unregistering all fallback handlers.
 */
export function registerClientStorageFallbackHandlers(
  bus: IMakaioBus,
  getLoadedAdapters: () => readonly LoadedAdapterClientRefs[],
): () => void {
  const getCleanup = bus.on(
    ClientStorageSubjects.get,
    async (ctx) => {
      const client = (await buildClientRecordMap(bus, getLoadedAdapters())).get(ctx.payload.id) ?? null;
      ctx.setResult({ client });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listCleanup = bus.on(
    ClientStorageSubjects.list,
    async (ctx) => {
      ctx.setResult({ clients: [...(await buildClientRecordMap(bus, getLoadedAdapters())).values()] });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );
  const listByBinaryNameCleanup = bus.on(
    ClientStorageSubjects.listByBinaryName,
    async (ctx) => {
      const clients = [...(await buildClientRecordMap(bus, getLoadedAdapters())).values()].filter(
        (client) => client.binary?.name === ctx.payload.binaryName,
      );
      ctx.setResult({ clients });
    },
    { priority: FALLBACK_HANDLER_PRIORITY },
  );

  return () => {
    getCleanup();
    listCleanup();
    listByBinaryNameCleanup();
  };
}

/**
 * Build enabled client records for client IDs referenced by loaded adapters.
 * @param bus - Bus used to read the current contribution catalog.
 * @param adapters - Loaded adapter client-reference snapshot.
 * @returns Client records keyed by stable client ID.
 */
async function buildClientRecordMap(
  bus: IMakaioBus,
  adapters: readonly LoadedAdapterClientRefs[],
): Promise<Map<string, ClientRecord>> {
  const referencedClientIds = new Set(adapters.flatMap((adapter) => adapter.clients?.map(({ id }) => id) ?? []));
  if (referencedClientIds.size === 0) {
    return new Map();
  }

  const catalog = await bus.request(ExtensionSubjects.contributions.catalog, {});
  const clients = new Map<string, ClientRecord>();
  for (const entry of catalog.clients) {
    if (!referencedClientIds.has(entry.definition.id)) continue;
    const definition = ClientDefinitionSchema.parse(entry.definition);
    clients.set(definition.id, toClientRecord(entry.packageName, definition));
  }
  return clients;
}

/**
 * Convert one package-owned definition into the storage read model.
 * @param packageName - Client package identity from the contribution catalog.
 * @param definition - Parsed client definition.
 * @returns Enabled, immutable runtime client record.
 */
function toClientRecord(packageName: string, definition: ClientDefinition): ClientRecord {
  return {
    id: definition.id,
    packageName,
    name: definition.name,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.binary !== undefined ? { binary: structuredClone(definition.binary) } : {}),
    nativeTools: structuredClone(definition.nativeTools),
    defaultApprovalPolicy: definition.defaultApprovalPolicy,
    ...(definition.logSources !== undefined ? { logSources: structuredClone(definition.logSources) } : {}),
    authMethods: structuredClone(definition.authMethods),
    ...(definition.defaultAuth !== undefined ? { defaultAuth: { ...definition.defaultAuth } } : {}),
    enabled: true,
    createdAt: RUNTIME_RECORD_TIMESTAMP,
    updatedAt: RUNTIME_RECORD_TIMESTAMP,
  };
}
