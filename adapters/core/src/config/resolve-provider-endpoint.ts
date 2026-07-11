import type { IMakaioBus } from '@makaio/bus-core';
import { AuthFieldIdSchema, type ProtocolId } from '@makaio/contracts';
import { ConnectorCredentialResolutionError, resolveConnectorCredentials } from './resolve-connector-credentials.js';
import { resolveProviderResolution } from './resolve-provider-resolution.js';

/** Stable authenticated endpoint-resolution failure categories. */
export type ProviderEndpointAuthErrorCode =
  | 'fetch-auth-unsupported'
  | 'fetch-auth-missing'
  | 'fetch-auth-resolution-failed';

/** Typed, credential-free failure for authenticated direct provider fetches. */
export class ProviderEndpointAuthError extends Error {
  /**
   * Create an authenticated endpoint-resolution failure.
   * @param code - Stable failure category
   */
  public constructor(public readonly code: ProviderEndpointAuthErrorCode) {
    super(`Authenticated provider endpoint resolution failed (${code}).`);
    this.name = 'ProviderEndpointAuthError';
  }
}

/**
 * Resolved HTTP endpoint credentials for a provider.
 * Returned by {@link resolveProviderEndpoint} for use by infrastructure-layer
 * consumers (bridges, cloud STT/TTS clients, etc.) that need to make direct
 * HTTP calls to a provider API without an agent context.
 */
export interface ProviderEndpoint {
  /** Base URL for the provider's HTTP API. */
  baseUrl: string;
  /**
   * API key for authenticating requests to the provider.
   * This helper is intentionally scoped to apiKey-authenticated HTTP providers.
   */
  apiKey: string;
}

/** Explicit credential-field requirement for the API-key endpoint consumer. */
export interface ProviderEndpointAuthRequirement {
  /** This endpoint helper currently supports API-key authorization only. */
  readonly kind: 'api-key';
  /** Selected auth-method field whose value the HTTP client accepts as its API key. */
  readonly credentialFieldId: string;
}

/**
 * Resolve `{ baseUrl, apiKey }` for a given provider config and wire protocol
 * without requiring an agent context.
 *
 * Intended for infrastructure-layer consumers (e.g., adapter-voice-bridge, cloud
 * STT/TTS providers) that need to make HTTP calls to cloud providers but are not
 * part of an agent turn.
 *
 * Delegates the atomic config/definition/auth read to
 * {@link resolveProviderResolution}, then resolves only the explicitly selected
 * `apiKey` ref through the trusted local credential channel. Inferred and
 * unauthenticated selections remain valid for refs-only endpoint resolution,
 * but cannot authorize this API-key-specific fetch seam.
 *
 * Resolution order for the endpoint URL:
 * 1. `ProviderConfig.endpointOverrides[protocol]` (user-customised URL)
 * 2. `ProviderDefinition.endpoints[protocol]` (default from provider package)
 *
 * Credentials are resolved from the normalized explicit auth selection. No
 * environment or SDK ambient fallback is consulted.
 * @param bus - Makaio bus instance used to query storage and resolve credential refs
 * @param providerConfigId - UUID of the ProviderConfig entity to resolve
 * @param protocol - Wire protocol to select the correct endpoint URL
 * @param authRequirement - Explicit API-key field required by the direct HTTP consumer
 * @returns Resolved `{ baseUrl, apiKey }` for the provider
 * @throws Error when the ProviderConfig or its ProviderDefinition is not found, or
 *   when `baseUrl` or `apiKey` cannot be resolved from any source
 */
export async function resolveProviderEndpoint(
  bus: IMakaioBus,
  providerConfigId: string,
  protocol: ProtocolId,
  authRequirement: ProviderEndpointAuthRequirement,
): Promise<ProviderEndpoint> {
  const { baseUrl, auth } = await resolveProviderResolution(bus, providerConfigId, protocol);

  if (!baseUrl) {
    throw new Error(
      `Could not resolve baseUrl for ProviderConfig '${providerConfigId}' with protocol '${protocol}'. ` +
        'Ensure the provider definition or config override declares an endpoint for this protocol.',
    );
  }

  if (auth.mode !== 'explicit') {
    throw new ProviderEndpointAuthError('fetch-auth-unsupported');
  }

  const fieldId = AuthFieldIdSchema.safeParse(authRequirement.credentialFieldId);
  if (authRequirement.kind !== 'api-key' || !fieldId.success) {
    throw new ProviderEndpointAuthError('fetch-auth-unsupported');
  }

  const selectedField = auth.definition.fields.find(({ id }) => id === fieldId.data);
  if (selectedField === undefined) {
    throw new ProviderEndpointAuthError('fetch-auth-unsupported');
  }

  const apiKeyRef = auth.credentialRefs[selectedField.id];
  if (apiKeyRef === undefined) {
    throw new ProviderEndpointAuthError('fetch-auth-missing');
  }

  let apiKey: string | undefined;
  try {
    apiKey = (await resolveConnectorCredentials(bus, { apiKey: apiKeyRef })).apiKey;
  } catch (error) {
    if (error instanceof ConnectorCredentialResolutionError && error.code === 'credential-unavailable') {
      throw new ProviderEndpointAuthError('fetch-auth-missing');
    }
    throw new ProviderEndpointAuthError('fetch-auth-resolution-failed');
  }

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new ProviderEndpointAuthError('fetch-auth-missing');
  }

  return { baseUrl, apiKey };
}
