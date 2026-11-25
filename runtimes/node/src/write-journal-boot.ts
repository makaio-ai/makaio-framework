import type { IMakaioBus } from '@makaio/bus-core';
import type { CoordinatorRights, ExtensionCoordinator } from '@makaio/kernel';
import type { HostDatabase } from '@makaio/contracts';
import { createWriteJournal, type WriteJournalPolicy } from '@makaio/services-core/journal';

/**
 * Set up the optional external write journal during Node host boot.
 * @param database - Shared database facade.
 * @param bus - Host bus.
 * @param rights - Shared host rights resolver.
 * @param credentialResolver - Read the coordinator's active resolver.
 * @param policy - Host authorization and deadline policy.
 * @returns The journal wiring when enabled.
 */
export function setupWriteJournal(
  database: HostDatabase,
  bus: IMakaioBus,
  rights: CoordinatorRights['hostRights'],
  credentialResolver: ExtensionCoordinator['credentials']['activeResolver'],
  policy?: WriteJournalPolicy,
) {
  return policy === undefined ? undefined : createWriteJournal(database, bus, rights, policy, credentialResolver);
}
