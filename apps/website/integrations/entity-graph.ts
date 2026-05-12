import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClientEntity {
  id: string;
  name: string;
  description: string;
  binaryName?: string;
  /** Filesystem directory name (e.g. `claude-code`). */
  slug: string;
}

export interface AdapterEntity {
  name: string;
  displayName: string;
  description: string;
  protocols: string[];
  clients: { id: string; version: string }[];
  /** Filesystem directory name (e.g. `anthropic-sdk`). */
  slug: string;
}

export interface ProviderEntity {
  id: string;
  name: string;
  description: string;
  protocols: string[];
  requiredClient?: string;
  /** Filesystem directory name (e.g. `anthropic`). */
  slug: string;
}

export interface EntityGraph {
  clients: ClientEntity[];
  adapters: AdapterEntity[];
  providers: ProviderEntity[];

  /** Adapter names compatible with a given provider id. */
  providerToAdapters: ReadonlyMap<string, readonly AdapterEntity[]>;
  /** Provider ids compatible with a given adapter name. */
  adapterToProviders: ReadonlyMap<string, readonly ProviderEntity[]>;
  /** Client ids that supply a given adapter (via adapter.clients[]). */
  adapterToClients: ReadonlyMap<string, readonly ClientEntity[]>;
  /** Adapter names that require a given client id. */
  clientToAdapters: ReadonlyMap<string, readonly AdapterEntity[]>;
  /** Provider ids reachable from a given client (via adapter chain or requiredClient). */
  clientToProviders: ReadonlyMap<string, readonly ProviderEntity[]>;
  /** Client ids that can reach a given provider (via adapter chain or requiredClient). */
  providerToClients: ReadonlyMap<string, readonly ClientEntity[]>;
}

// ---------------------------------------------------------------------------
// Internal edge-computation result types
// ---------------------------------------------------------------------------

interface AdapterProviderEdges {
  providerToAdapters: Map<string, AdapterEntity[]>;
  adapterToProviders: Map<string, ProviderEntity[]>;
}

interface AdapterClientEdges {
  adapterToClients: Map<string, ClientEntity[]>;
  clientToAdapters: Map<string, AdapterEntity[]>;
}

interface ClientProviderEdges {
  clientToProviders: Map<string, ProviderEntity[]>;
  providerToClients: Map<string, ClientEntity[]>;
}

// ---------------------------------------------------------------------------
// Descriptor shapes (subset relevant to the graph)
// ---------------------------------------------------------------------------

interface ClientDescriptor {
  contributions?: {
    clients?: { id: string; name: string; description: string; binaryName?: string }[];
  };
}

interface AdapterDescriptor {
  contributions?: {
    adapters?: {
      name: string;
      displayName: string;
      description: string;
      protocols?: string[];
      clients?: { id: string; version: string }[];
    }[];
  };
}

interface ProviderDescriptor {
  contributions?: {
    providers?: {
      id: string;
      name: string;
      description: string;
      protocols?: string[];
      requiredClient?: string;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/**
 * Reads and parses a JSON file, returning `undefined` when the file does not exist.
 * @param filePath - Absolute path to the JSON file.
 * @returns Parsed JSON content or `undefined`.
 */
function readJsonSafe<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

/**
 * Scans `clients/` for descriptor-declared client contributions.
 * @returns Sorted array of client entities.
 */
function discoverClients(): ClientEntity[] {
  const clientsDir = path.join(FRAMEWORK_ROOT, 'clients');
  if (!fs.existsSync(clientsDir)) return [];

  const entities: ClientEntity[] = [];
  for (const entry of fs.readdirSync(clientsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const descriptor = readJsonSafe<ClientDescriptor>(path.join(clientsDir, entry.name, 'descriptor.json'));
    for (const client of descriptor?.contributions?.clients ?? []) {
      entities.push({ ...client, slug: entry.name });
    }
  }
  return entities.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Scans `adapters/implementations/` for descriptor-declared adapter contributions.
 * @returns Sorted array of adapter entities.
 */
function discoverAdapters(): AdapterEntity[] {
  const implDir = path.join(FRAMEWORK_ROOT, 'adapters', 'implementations');
  if (!fs.existsSync(implDir)) return [];

  const entities: AdapterEntity[] = [];
  for (const entry of fs.readdirSync(implDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const descriptor = readJsonSafe<AdapterDescriptor>(path.join(implDir, entry.name, 'descriptor.json'));
    for (const adapter of descriptor?.contributions?.adapters ?? []) {
      entities.push({
        name: adapter.name,
        displayName: adapter.displayName,
        description: adapter.description,
        protocols: adapter.protocols ?? [],
        clients: adapter.clients ?? [],
        slug: entry.name,
      });
    }
  }
  return entities.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scans `providers/` for descriptor-declared provider contributions.
 * @returns Sorted array of provider entities.
 */
function discoverProviders(): ProviderEntity[] {
  const providersDir = path.join(FRAMEWORK_ROOT, 'providers');
  if (!fs.existsSync(providersDir)) return [];

  const entities: ProviderEntity[] = [];
  for (const entry of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const descriptor = readJsonSafe<ProviderDescriptor>(path.join(providersDir, entry.name, 'descriptor.json'));
    for (const provider of descriptor?.contributions?.providers ?? []) {
      entities.push({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        protocols: provider.protocols ?? [],
        requiredClient: provider.requiredClient,
        slug: entry.name,
      });
    }
  }
  return entities.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Graph computation
// ---------------------------------------------------------------------------

/**
 * Two entities are protocol-compatible when their protocol sets intersect.
 * @param a - Protocol list of the first entity.
 * @param b - Protocol list of the second entity.
 * @returns `true` when at least one protocol is shared.
 */
function protocolsIntersect(a: readonly string[], b: readonly string[]): boolean {
  return a.some((p) => b.includes(p));
}

/**
 * An adapter is compatible with a provider when:
 * 1. Their protocols intersect, AND
 * 2. The provider has no `requiredClient`, or the required client is one of the adapter's declared clients.
 * @param adapter - Adapter to check.
 * @param provider - Provider to check against.
 * @returns `true` when the adapter can serve the provider.
 */
function adapterCompatibleWithProvider(adapter: AdapterEntity, provider: ProviderEntity): boolean {
  if (!protocolsIntersect(adapter.protocols, provider.protocols)) return false;
  if (!provider.requiredClient) return true;
  return adapter.clients.some((c) => c.id === provider.requiredClient);
}

/**
 * Appends a value to a map-of-arrays, creating the array on first access.
 * @param map - Target map.
 * @param key - Lookup key.
 * @param value - Value to append.
 */
function mapPush<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

/**
 * Computes bidirectional adapter ↔ provider compatibility via protocol intersection and requiredClient check.
 * @param adapters - All discovered adapters.
 * @param providers - All discovered providers.
 * @returns Pair of maps: provider→adapters and adapter→providers.
 */
function computeAdapterProviderEdges(
  adapters: readonly AdapterEntity[],
  providers: readonly ProviderEntity[],
): AdapterProviderEdges {
  const providerToAdapters = new Map<string, AdapterEntity[]>();
  const adapterToProviders = new Map<string, ProviderEntity[]>();
  for (const adapter of adapters) {
    for (const provider of providers) {
      if (adapterCompatibleWithProvider(adapter, provider)) {
        mapPush(providerToAdapters, provider.id, adapter);
        mapPush(adapterToProviders, adapter.name, provider);
      }
    }
  }
  return { providerToAdapters, adapterToProviders };
}

/**
 * Computes bidirectional adapter ↔ client bindings from adapter.clients[] declarations.
 * @param adapters - All discovered adapters.
 * @param clientById - Client lookup map.
 * @returns Pair of maps: adapter→clients and client→adapters.
 */
function computeAdapterClientEdges(
  adapters: readonly AdapterEntity[],
  clientById: ReadonlyMap<string, ClientEntity>,
): AdapterClientEdges {
  const adapterToClients = new Map<string, ClientEntity[]>();
  const clientToAdapters = new Map<string, AdapterEntity[]>();
  for (const adapter of adapters) {
    for (const ref of adapter.clients) {
      const client = clientById.get(ref.id);
      if (!client) continue;
      mapPush(adapterToClients, adapter.name, client);
      mapPush(clientToAdapters, client.id, adapter);
    }
  }
  return { adapterToClients, clientToAdapters };
}

/**
 * Computes transitive client ↔ provider reachability through the adapter chain,
 * including generic (clientless) adapters that expose providers to all clients.
 * @param clients - All discovered clients.
 * @param adapters - All discovered adapters.
 * @param clientToAdapters - Direct client→adapter bindings.
 * @param adapterToProviders - Adapter→provider compatibility.
 * @returns Pair of maps: client→providers and provider→clients.
 */
function computeClientProviderEdges(
  clients: readonly ClientEntity[],
  adapters: readonly AdapterEntity[],
  clientToAdapters: ReadonlyMap<string, readonly AdapterEntity[]>,
  adapterToProviders: ReadonlyMap<string, readonly ProviderEntity[]>,
): ClientProviderEdges {
  const clientToProviders = new Map<string, ProviderEntity[]>();
  const providerToClients = new Map<string, ClientEntity[]>();

  for (const client of clients) {
    const seen = new Set<string>();
    for (const adapter of clientToAdapters.get(client.id) ?? []) {
      for (const provider of adapterToProviders.get(adapter.name) ?? []) {
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);
        mapPush(clientToProviders, client.id, provider);
        mapPush(providerToClients, provider.id, client);
      }
    }
  }

  // Generic adapters (no client binding) expose their providers to ALL clients.
  const genericAdapters = adapters.filter((a) => a.clients.length === 0);
  for (const adapter of genericAdapters) {
    for (const provider of adapterToProviders.get(adapter.name) ?? []) {
      for (const client of clients) {
        const cp = clientToProviders.get(client.id) ?? [];
        if (!cp.some((p) => p.id === provider.id)) {
          mapPush(clientToProviders, client.id, provider);
        }
        const pc = providerToClients.get(provider.id) ?? [];
        if (!pc.some((c) => c.id === client.id)) {
          mapPush(providerToClients, provider.id, client);
        }
      }
    }
  }

  return { clientToProviders, providerToClients };
}

/**
 * Builds the full entity relationship graph from framework descriptors.
 * @returns Fully computed entity graph with all cross-references.
 */
export function buildEntityGraph(): EntityGraph {
  const clients = discoverClients();
  const adapters = discoverAdapters();
  const providers = discoverProviders();

  const clientById = new Map(clients.map((c) => [c.id, c]));
  const { providerToAdapters, adapterToProviders } = computeAdapterProviderEdges(adapters, providers);
  const { adapterToClients, clientToAdapters } = computeAdapterClientEdges(adapters, clientById);
  const { clientToProviders, providerToClients } = computeClientProviderEdges(
    clients,
    adapters,
    clientToAdapters,
    adapterToProviders,
  );

  return {
    clients,
    adapters,
    providers,
    providerToAdapters,
    adapterToProviders,
    adapterToClients,
    clientToAdapters,
    clientToProviders,
    providerToClients,
  };
}
