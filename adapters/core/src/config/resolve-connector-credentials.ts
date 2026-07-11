import { createBusInstance, openChannel, type MakaioBusContext } from '@makaio/bus-core';
import type { CredentialRef } from '@makaio/contracts/config';
import { CredentialSubjects } from '@makaio/contracts';

/** Minimal bus surface needed to resolve credentials against the shared runtime context. */
interface CredentialBusContextProvider {
  getContext(): MakaioBusContext;
}

/** Stable credential-resolution failure categories. */
export type ConnectorCredentialResolutionErrorCode = 'credential-unavailable' | 'credential-request-failed';

/** Trusted resolution policy for refs selected by a normalized auth method. */
export interface ConnectorCredentialResolutionOptions {
  /** Selected field names whose unavailable refs are intentionally omitted. */
  readonly optionalFields?: readonly string[];
}

/**
 * Typed credential-resolution failure that never retains a ref, secret, or provider error.
 */
export class ConnectorCredentialResolutionError extends Error {
  /**
   * Create a sanitized connector credential failure.
   * @param code - Stable failure category
   */
  public constructor(public readonly code: ConnectorCredentialResolutionErrorCode) {
    super(
      code === 'credential-unavailable' ? 'A selected credential is unavailable.' : 'Credential resolution failed.',
    );
    this.name = 'ConnectorCredentialResolutionError';
  }
}

/**
 * Resolve credential references to plaintext values at the connector layer.
 *
 * Opens an encrypted DirectChannel, resolves all refs in parallel, and
 * closes the channel after use. Connectors call this during initialization
 * or credential rotation — plaintext never leaves the connector.
 *
 * Returns an empty object immediately when `credentialRefs` is empty,
 * avoiding an unnecessary channel round-trip. Resolution is atomic for
 * required refs: every required ref must produce a value or the whole
 * operation fails with a sanitized typed error. Trusted normalized-auth
 * callers may declare optional selected fields; unavailable optional refs are
 * omitted rather than turning an explicit selection into an ambient fallback.
 * @param bus - Bus instance with context access for channel token retrieval
 * @param credentialRefs - Credential refs keyed by field name
 * @param options - Trusted required/optional policy for selected fields
 * @returns Plaintext credential values keyed by field name
 */
export async function resolveConnectorCredentials(
  bus: CredentialBusContextProvider,
  credentialRefs: Record<string, CredentialRef>,
  options: ConnectorCredentialResolutionOptions = {},
): Promise<Record<string, string>> {
  const entries = Object.entries(credentialRefs);
  if (entries.length === 0) {
    return {};
  }

  const resolved: Record<string, string> = {};
  const optionalFields = new Set(options.optionalFields);
  const context = bus.getContext();
  const rootBus = createBusInstance({ context });
  const { token } = await rootBus.request(CredentialSubjects.getChannelToken, {});
  const channel = await openChannel(context, 'credentials', { token, transports: [] });

  try {
    const values = await Promise.all(
      entries.map(async ([field, ref]) => {
        try {
          const result = await channel.request(CredentialSubjects.resolve, { ref });
          if (result.value === null) {
            if (optionalFields.has(field)) return undefined;
            throw new ConnectorCredentialResolutionError('credential-unavailable');
          }
          return [field, result.value] as const;
        } catch (error) {
          if (error instanceof ConnectorCredentialResolutionError) {
            throw error;
          }
          throw new ConnectorCredentialResolutionError('credential-request-failed');
        }
      }),
    );

    for (const [field, value] of values.filter((entry): entry is readonly [string, string] => entry !== undefined)) {
      resolved[field] = value;
    }
  } finally {
    channel.close();
  }

  return resolved;
}
