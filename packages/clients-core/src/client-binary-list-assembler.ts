/**
 * List-assembly logic for the `client.list` bus subject.
 *
 * {@link assembleBinaryList} builds the installation inventory for all managed
 * clients. It is extracted from {@link ClientBinaryManager} so that the manager
 * focuses on lifecycle and job orchestration while this module owns the
 * read-model assembly concern.
 * @packageDocumentation
 */

import type { ClientBinaryListEntry, InstalledVersionEntry, ManagedInstallDescriptor } from '@makaio/contracts/client';
import type { ClientDefinitionLookup } from './client-binary-manager-types.js';
import { ClientBinaryStorageSubjects } from './storage/client-binary-storage-namespace.js';
import type { IMakaioBus } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assemble the installation inventory for all managed clients.
 *
 * Returns one {@link ClientBinaryListEntry} per managed client known to the
 * definition lookup, enriched with installed versions, the active version
 * pointer, the descriptor pin, and the `updateAvailable` flag. A client is
 * considered to have an update available when its active version does not
 * match the pinned version in the managed install descriptor.
 * @param bus - Bus instance for storage snapshot requests
 * @param definitionLookup - Client definition registry
 * @returns Assembled list of client binary entries
 */
export async function assembleBinaryList(
  bus: IMakaioBus,
  definitionLookup: ClientDefinitionLookup,
): Promise<ClientBinaryListEntry[]> {
  const { versions: allVersions, states } = await bus.request(ClientBinaryStorageSubjects.loadSnapshot, {});

  const versionsByClient = Map.groupBy(allVersions, (v) => v.clientId);

  const activeVersionByClient = new Map<string, string | null>();
  for (const s of states) {
    activeVersionByClient.set(s.clientId, s.activeVersion);
  }

  // Build a clientId → descriptor map from the definition registry.
  const descriptorByClient = new Map<string, ManagedInstallDescriptor>();
  for (const definition of definitionLookup.listDefinitions()) {
    if (definition.managedInstall !== undefined) {
      descriptorByClient.set(definition.id, definition.managedInstall);
    }
  }

  // Include every managed client ID known to the definition registry. Storage
  // may also hold persisted state for clients whose descriptor is temporarily
  // absent; those are omitted from the list because there is no pin to report.
  const clientIds = new Set<string>(descriptorByClient.keys());

  return [...clientIds].map((clientId) => {
    const descriptor = descriptorByClient.get(clientId);
    // All clientIds in the set come from the descriptor map, so this is always
    // defined. The type-narrowing assert documents this invariant clearly.
    if (descriptor === undefined) {
      throw new Error(`assembleBinaryList: missing descriptor for client '${clientId}'`);
    }
    const activeVersion = activeVersionByClient.get(clientId) ?? null;
    const versionRecords = versionsByClient.get(clientId) ?? [];
    const installedVersions: InstalledVersionEntry[] = versionRecords.map((v) => ({
      version: v.version,
      installPath: v.installPath,
      installedAt: v.installedAt,
      isActive: v.version === activeVersion,
    }));
    const pinnedVersion = descriptor.version;
    // Version comparison uses string inequality — sufficient for V1 where
    // versions are opaque identifiers pinned to an exact release.
    const updateAvailable = activeVersion !== null && activeVersion !== pinnedVersion;
    return {
      clientId,
      installedVersions,
      activeVersion,
      pinnedVersion,
      updateAvailable,
    };
  });
}
