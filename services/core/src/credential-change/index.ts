import type { IMakaioBus } from '@makaio/bus-core';

const credentialChangeSequences = new Map<IMakaioBus, Map<string, number>>();

/**
 * Look up or create the sequence store for one bus instance.
 * @param bus - Bus whose runtime owns the credential-change sequence space
 * @returns Mutable sequence store keyed by provider config ID
 */
function getSequenceStore(bus: IMakaioBus): Map<string, number> {
  const existing = credentialChangeSequences.get(bus);
  if (existing) {
    return existing;
  }

  const created = new Map<string, number>();
  credentialChangeSequences.set(bus, created);
  return created;
}

/**
 * Allocate the next monotonic credential-change sequence for one provider config on one bus instance.
 * @param bus - Bus whose runtime owns the sequence space
 * @param providerConfigId - Provider config whose sequence should advance
 * @returns Next strictly increasing sequence number for the provider config
 */
export function nextCredentialChangeSequence(bus: IMakaioBus, providerConfigId: string): number {
  const store = getSequenceStore(bus);
  const next = (store.get(providerConfigId) ?? 0) + 1;
  store.set(providerConfigId, next);
  return next;
}

/**
 * Reset credential-change sequence tracking for tests or teardown.
 * @param bus - Optional bus to clear; omit to clear all tracked buses
 */
export function resetCredentialChangeSequences(bus?: IMakaioBus): void {
  if (bus) {
    credentialChangeSequences.delete(bus);
    return;
  }

  credentialChangeSequences.clear();
}
