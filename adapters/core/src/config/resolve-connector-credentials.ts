import { createBusInstance, openChannel, type MakaioBusContext } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import { CredentialSubjects } from '@makaio/contracts';

/** Minimal bus surface needed to resolve credentials against the shared runtime context. */
interface CredentialBusContextProvider {
  getContext(): MakaioBusContext;
}

/**
 * Resolve credential references to plaintext values at the connector layer.
 *
 * Opens an encrypted DirectChannel, resolves all refs in parallel, and
 * closes the channel after use. Connectors call this during initialization
 * or credential rotation — plaintext never leaves the connector.
 *
 * Returns an empty object immediately when `credentialRefs` is empty,
 * avoiding an unnecessary channel round-trip. Partial failures are
 * tolerated: refs that fail to resolve are omitted and logged. Callers
 * must still validate any required credential fields before using the
 * returned record to build env or client config.
 * @param bus - Bus instance with context access for channel token retrieval
 * @param credentialRefs - Credential refs keyed by field name
 * @returns Plaintext credential values keyed by field name
 */
export async function resolveConnectorCredentials(
  bus: CredentialBusContextProvider,
  credentialRefs: Record<string, CredentialRef>,
): Promise<Record<string, string>> {
  const entries = Object.entries(credentialRefs);
  if (entries.length === 0) {
    return {};
  }

  const resolved: Record<string, string> = {};
  const context = bus.getContext();
  const rootBus = createBusInstance({ context });
  const { token } = await rootBus.request(CredentialSubjects.getChannelToken, {});
  const channel = await openChannel(context, 'credentials', { token, transports: [] });

  try {
    const results = await Promise.allSettled(
      entries.map(([, ref]) => channel.request(CredentialSubjects.resolve, { ref })),
    );

    for (let i = 0; i < entries.length; i++) {
      const [field, ref] = entries[i];
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (result.value.value !== null) {
          resolved[field] = result.value.value;
        } else if (result.value.error) {
          // Credential refs are opaque objects; serialize them so warnings point to the failing field
          // instead of logging "[object Object]" when resolution fails in connector startup/swap flows.
          const refDescription = JSON.stringify(ref);
          console.warn(
            `[resolveConnectorCredentials] Failed to resolve field '${field}' (ref ${refDescription}):`,
            result.value.error,
          );
        } else {
          const refDescription = JSON.stringify(ref);
          console.info(
            `[resolveConnectorCredentials] Credential unavailable for field '${field}' (ref ${refDescription}); omitting it from the resolved connector credentials.`,
          );
        }
      } else {
        // Keep the same serialized ref shape for rejected requests so both failure paths are comparable.
        const refDescription = JSON.stringify(ref);
        console.warn(
          `[resolveConnectorCredentials] Failed to resolve field '${field}' (ref ${refDescription}):`,
          result.reason,
        );
      }
    }
  } finally {
    channel.close();
  }

  return resolved;
}
