import type { IMakaioBus } from '@makaio/bus-core';
import type { AdapterClientRef } from '@makaio/contracts';
import { isUniversalRange, versionSatisfies } from '@makaio/contracts';
import { ClientSubjects, type ClientDefinition } from '@makaio/contracts/client';

/** Active client definition entry from the extension contribution catalog. */
export interface AdapterClientCatalogEntry {
  readonly packageName: string;
  readonly definition: ClientDefinition;
}

/** Runtime options used when resolving an adapter's default client. */
export interface ResolveDefaultClientIdOptions {
  /** Persisted or requested client ID override. */
  readonly clientId?: string;
}

/**
 * Clone adapter client references into adapter-subsystem-owned metadata.
 * @param clients - Client references declared by an adapter contribution.
 * @returns Cloned client references, or undefined when no clients are declared.
 */
export function cloneAdapterClientRefs(
  clients: readonly AdapterClientRef[] | undefined,
): readonly AdapterClientRef[] | undefined {
  if (clients === undefined || clients.length === 0) {
    return undefined;
  }

  return clients.map((client) => ({ ...client }));
}

/**
 * Resolve the default runtime client ID for a loaded adapter.
 *
 * `clientId` remains an initialization-time selected client override, but only
 * while it still references a client declared by the active adapter manifest.
 * When the override is absent or stale, client-backed adapters default to their
 * first declared client ref.
 * @param options - Runtime options that may carry a selected client ID.
 * @param clients - Client refs declared by the adapter contribution.
 * @returns Selected or default client ID, or undefined for API-only adapters.
 */
export function resolveDefaultClientId(
  options: ResolveDefaultClientIdOptions,
  clients: readonly AdapterClientRef[] | undefined,
): string | undefined {
  if (options.clientId !== undefined && clients?.some((client) => client.id === options.clientId)) {
    return options.clientId;
  }

  return clients?.[0]?.id;
}

/**
 * Validate adapter-declared client references before adapter activation.
 *
 * `version` is checked against the active client definition contract. When an
 * adapter also declares `binaryVersion`, the active runtime binary is resolved
 * through `client.resolveBinary` and checked against that binary range.
 * @param adapterName - Adapter name used in invariant error messages.
 * @param clients - Client refs declared by the adapter manifest.
 * @param catalogClients - Active client definitions from the extension catalog.
 * @param bus - Runtime bus used to resolve active binary versions when needed.
 */
export async function validateAdapterClientRefs(
  adapterName: string,
  clients: readonly AdapterClientRef[] | undefined,
  catalogClients: readonly AdapterClientCatalogEntry[],
  bus: IMakaioBus,
): Promise<void> {
  if (clients === undefined || clients.length === 0) return;

  const definitionsById = new Map(catalogClients.map((entry) => [entry.definition.id, entry.definition] as const));

  for (const ref of clients) {
    const definition = definitionsById.get(ref.id);
    if (definition === undefined) {
      throw new Error(`Adapter "${adapterName}" references missing client "${ref.id}"`);
    }
    assertSatisfiesRange(
      definition.version,
      ref.version,
      `Adapter "${adapterName}" client "${ref.id}" definition version ${definition.version}`,
    );
  }

  const binaryChecks = clients.filter((ref) => ref.binaryVersion !== undefined);
  await Promise.all(
    binaryChecks.map(async (ref) => {
      if (isUniversalRange(ref.binaryVersion!)) return;

      const resolved = await bus.requestOptional(ClientSubjects.resolveBinary, { clientId: ref.id });
      if (!resolved.handled) {
        throw new Error(
          `Adapter "${adapterName}" client "${ref.id}" declares binaryVersion ${ref.binaryVersion}, but no client.resolveBinary handler is registered`,
        );
      }
      const binaryVersion = resolved.data.version;
      if (binaryVersion === null) {
        throw new Error(
          `Adapter "${adapterName}" client "${ref.id}" binary did not report a version; requires ${ref.binaryVersion}`,
        );
      }
      assertSatisfiesRange(
        binaryVersion,
        ref.binaryVersion!,
        `Adapter "${adapterName}" client "${ref.id}" binary version ${binaryVersion}`,
      );
    }),
  );
}

/**
 * Throw when a concrete version does not satisfy a semver range.
 * @param version - Concrete semver version.
 * @param range - Semver range to satisfy.
 * @param label - Error prefix describing the checked entity.
 */
function assertSatisfiesRange(version: string, range: string, label: string): void {
  if (versionSatisfies(version, range)) return;
  throw new Error(`${label} does not satisfy ${range}`);
}
