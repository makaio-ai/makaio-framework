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
import type { ClientBinaryFeedCache } from './client-binary-feed-cache.js';
import type { ClientBinaryVersionResolver } from './client-binary-version-resolver.js';
import type { ClientDefinitionLookup } from './client-binary-manager-types.js';
import { ClientBinaryStorageSubjects } from './storage/client-binary-storage-namespace.js';
import type { IMakaioBus } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Assemble the installation inventory for all managed clients.
 *
 * Optionally refreshes the feed cache from upstream before assembling the
 * response. The result contains one {@link ClientBinaryListEntry} per client
 * known to the definition lookup, enriched with installed versions, the
 * active version pointer, and the latest-available-version metadata.
 * @param bus - Bus instance for storage requests and feed refresh
 * @param versionResolver - Version resolver holding the in-memory feed cache
 * @param feedCache - Feed cache for persisting refreshed metadata
 * @param definitionLookup - Client definition registry
 * @param forceRefresh - When `true`, force a live upstream feed refresh
 * @returns Assembled list of client binary entries
 */
export async function assembleBinaryList(
  bus: IMakaioBus,
  versionResolver: ClientBinaryVersionResolver,
  feedCache: ClientBinaryFeedCache,
  definitionLookup: ClientDefinitionLookup,
  forceRefresh: boolean,
): Promise<ClientBinaryListEntry[]> {
  const { versions: allVersions, states } = await bus.request(ClientBinaryStorageSubjects.loadSnapshot, {});

  const versionsByClient = Map.groupBy(allVersions, (v) => v.clientId);

  const activeVersionByClient = new Map<string, string | null>();
  for (const s of states) {
    activeVersionByClient.set(s.clientId, s.activeVersion);
  }

  // Build a clientId → descriptor map from the definition registry. Used by
  // the refresh loop and the entry-assembly loop below, avoiding repeated
  // lookups against the registry.
  const descriptorByClient = new Map<string, ManagedInstallDescriptor>();
  for (const definition of definitionLookup.listDefinitions()) {
    if (definition.managedInstall !== undefined) {
      descriptorByClient.set(definition.id, definition.managedInstall);
    }
  }

  // Collect all known managed client IDs from the definition registry plus
  // any persisted state. Persisted state can outlive a temporarily missing
  // package, so storage-owned IDs remain visible with degraded feed metadata.
  const clientIds = new Set<string>([
    ...descriptorByClient.keys(),
    ...versionsByClient.keys(),
    ...activeVersionByClient.keys(),
  ]);

  // Refresh all feeds in parallel when requested. Each client targets a
  // different upstream (npm, GitHub, bucket) so there is no ordering
  // dependency. allSettled ensures one failure does not abort the rest.
  if (forceRefresh) {
    await Promise.allSettled(
      [...clientIds].map(async (clientId) => {
        const descriptor = descriptorByClient.get(clientId);
        if (descriptor === undefined) return;
        const refreshed = await versionResolver.refresh(clientId, descriptor);
        const refreshedMeta = versionResolver.getLatestVersionMeta(clientId);
        await feedCache.update(clientId, refreshedMeta.latestAvailableVersion, refreshed ? 'fresh' : 'error');
      }),
    );
  }

  return [...clientIds].map((clientId) => {
    const descriptor = descriptorByClient.get(clientId);
    const activeVersion = activeVersionByClient.get(clientId) ?? null;
    const versionRecords = versionsByClient.get(clientId) ?? [];
    const installedVersions: InstalledVersionEntry[] = versionRecords.map((v) => ({
      version: v.version,
      installPath: v.installPath,
      installedAt: v.installedAt,
      isActive: v.version === activeVersion,
    }));
    const cachedMeta = versionResolver.getLatestVersionMeta(clientId);
    // When forceRefresh was requested but no descriptor is registered, the
    // refresh could not happen. Downgrade the source status to 'error' so the
    // caller can distinguish "refresh attempted and failed" from "stale cache"
    // without losing the last-known upstream version.
    const meta =
      forceRefresh && descriptor === undefined
        ? { ...cachedMeta, latestVersionSourceStatus: 'error' as const }
        : cachedMeta;
    // Version comparison uses string inequality — sufficient for V1 where versions
    // are opaque identifiers. Semver-aware comparison is deferred until version
    // format conventions are established across strategies.
    const updateAvailable =
      activeVersion !== null && meta.latestAvailableVersion !== null && meta.latestAvailableVersion !== activeVersion;
    return {
      clientId,
      installedVersions,
      activeVersion,
      latestAvailableVersion: meta.latestAvailableVersion,
      latestVersionLastCheckedAt: meta.latestVersionLastCheckedAt,
      latestVersionSourceStatus: meta.latestVersionSourceStatus,
      updateAvailable,
    };
  });
}
