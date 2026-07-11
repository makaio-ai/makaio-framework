import type { IMakaioBus } from '@makaio/bus-core';
import type { ProtocolId, ResolvedProviderAuth } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import type { ProviderConfigFileRecord } from '@makaio/services-core/adapter-subsystem';
import type { ProviderRecord } from '@makaio/services-core/settings/storage';

/** Stable provider-resolution failure categories. */
export type ProviderResolutionErrorCode = 'provider-config-not-found';

/** Typed refs-only provider-resolution failure. */
export class ProviderResolutionError extends Error {
  /**
   * Create a provider-resolution failure.
   * @param code - Stable failure category.
   * @param message - Credential-free diagnostic.
   */
  public constructor(
    public readonly code: ProviderResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderResolutionError';
  }
}

/**
 * Definition-backed provider data plus the selected normalized auth snapshot.
 * Credential values remain refs and are resolved only by a trusted auth
 * consumer after adapter delivery has been selected.
 */
export interface ProviderResolution {
  /** Bus-safe provider config read model. */
  readonly config: ProviderConfigFileRecord;
  /** Provider definition referenced by the config. */
  readonly definition: ProviderRecord;
  /** Effective endpoint for the requested protocol, or null when undeclared. */
  readonly baseUrl: string | null;
  /** Validated normalized auth selection with credential refs, never plaintext. */
  readonly auth: ResolvedProviderAuth;
}

/**
 * Resolve one provider config to definition metadata, endpoint, and refs-only auth.
 *
 * The adapter subsystem is the sole owner of auth-method validation and returns
 * the safe config, refs-only context, and provider definition from one captured
 * snapshot. This helper never opens the credential DirectChannel.
 * @param bus - Bus instance for the atomic adapter-subsystem snapshot request.
 * @param providerConfigId - Explicit provider config ID.
 * @param protocol - Wire protocol used to select the endpoint URL.
 * @returns Definition-backed provider resolution without plaintext credentials.
 */
export async function resolveProviderResolution(
  bus: IMakaioBus,
  providerConfigId: string,
  protocol: ProtocolId,
): Promise<ProviderResolution> {
  const { snapshot } = await bus.request(AdapterSubsystemSubjects.resolveProviderRuntimeSnapshot, {
    providerConfigId,
  });
  if (!snapshot) {
    throw new ProviderResolutionError('provider-config-not-found', `ProviderConfig '${providerConfigId}' not found`);
  }
  const baseUrl = snapshot.context.endpointOverrides?.[protocol] ?? snapshot.definition.endpoints?.[protocol] ?? null;
  return {
    config: snapshot.config,
    definition: snapshot.definition,
    baseUrl,
    auth: snapshot.context.auth,
  };
}
