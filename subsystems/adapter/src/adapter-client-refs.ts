import type { IMakaioBus } from '@makaio/bus-core';
import type { AdapterClientRef } from '@makaio/contracts';
import { isUniversalRange, versionSatisfies } from '@makaio/contracts';
import { ClientSubjects, type ClientDefinition } from '@makaio/contracts/client';

// Duplicated in client-binary-version-support.ts — kept inline to avoid
// a cross-subsystem dependency for a single env-var read.
const SKIP_VERSION_CHECK = process.env.MAKAIO_SKIP_CLIENT_VERSION_CHECK === '1';

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
 * Validation controls for adapter-declared client references.
 */
export interface ValidateAdapterClientRefsOptions {
  /**
   * Whether to resolve and validate concrete native binary versions.
   *
   * Static client definition compatibility is always checked. Binary
   * availability is runtime state, so callers that are only registering a
   * disabled adapter can defer this check until initialization.
   */
  readonly checkBinaryVersions?: boolean;
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
 * @param options - Validation options controlling runtime binary checks.
 */
export async function validateAdapterClientRefs(
  adapterName: string,
  clients: readonly AdapterClientRef[] | undefined,
  catalogClients: readonly AdapterClientCatalogEntry[],
  bus: IMakaioBus,
  options: ValidateAdapterClientRefsOptions = {},
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

  if (options.checkBinaryVersions === false) return;

  // Each binary-check guard has a distinct error message describing a
  // different failure mode (no handler, null version, range mismatch).
  // A shared helper would either lose that specificity or need a
  // parameter for every variant, so the pattern is kept inline.
  const binaryChecks = clients.filter((ref) => ref.binaryVersion !== undefined);
  await Promise.all(
    binaryChecks.map(async (ref) => {
      if (isUniversalRange(ref.binaryVersion!)) return;

      const resolved = await bus.requestOptional(ClientSubjects.resolveBinary, { clientId: ref.id });
      if (!resolved.handled) {
        if (SKIP_VERSION_CHECK) {
          console.warn(
            `[SKIP_VERSION_CHECK] Adapter "${adapterName}" client "${ref.id}" declares binaryVersion ${ref.binaryVersion}, but no client.resolveBinary handler is registered — check bypassed`,
          );
          return;
        }
        throw new Error(
          `Adapter "${adapterName}" client "${ref.id}" declares binaryVersion ${ref.binaryVersion}, but no client.resolveBinary handler is registered`,
        );
      }
      const binaryVersion = resolved.data.version;
      if (binaryVersion === null) {
        if (SKIP_VERSION_CHECK) {
          console.warn(
            `[SKIP_VERSION_CHECK] Adapter "${adapterName}" client "${ref.id}" binary did not report a version; requires ${ref.binaryVersion} — check bypassed`,
          );
          return;
        }
        throw new Error(
          `Adapter "${adapterName}" client "${ref.id}" binary did not report a version; requires ${ref.binaryVersion}`,
        );
      }
      if (!versionSatisfies(binaryVersion, ref.binaryVersion!)) {
        const label = `Adapter "${adapterName}" client "${ref.id}" binary version ${binaryVersion}`;
        if (SKIP_VERSION_CHECK) {
          console.warn(`[SKIP_VERSION_CHECK] ${label} does not satisfy ${ref.binaryVersion} — check bypassed`);
          return;
        }
        throw new Error(`${label} does not satisfy ${ref.binaryVersion}`);
      }
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
