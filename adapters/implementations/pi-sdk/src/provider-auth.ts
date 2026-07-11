import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { ProtocolId, ProviderContext, ResolvedProviderContext } from '@makaio/contracts';

/** Connector target owned by Pi's provider auth storage. */
export const PI_PROVIDER_AUTH_TARGET = 'pi-sdk.provider-auth';

/** Credential-free error for missing, malformed, or foreign Pi delivery. */
export class PiSdkAuthDeliveryError extends Error {
  public constructor() {
    super('Pi SDK provider authentication delivery is invalid.');
    this.name = 'PiSdkAuthDeliveryError';
  }
}

/** Credential-free failure for an absent or unresolved Pi provider selection. */
export class PiSdkProviderContextError extends Error {
  public constructor() {
    super('Pi SDK requires a resolved provider context.');
    this.name = 'PiSdkProviderContextError';
  }
}

/** Credential-free failure for an adapter/provider path without an HTTP protocol. */
export class PiSdkProviderProtocolError extends Error {
  public constructor() {
    super('Pi SDK requires an adapter/provider protocol declaration.');
    this.name = 'PiSdkProviderProtocolError';
  }
}

/**
 * Consume the required Pi provider API-key delivery.
 * @param auth - Final connector-local authentication snapshot
 * @returns Selected provider API key
 */
export function resolvePiProviderApiKey(auth: ResolvedAdapterAuth | undefined): string {
  const deliveries = auth?.connectorDeliveries ?? [];
  if (
    auth === undefined ||
    Object.keys(auth.processEnv).length !== 0 ||
    auth.configInheritance !== 'empty' ||
    deliveries.length !== 1 ||
    deliveries[0]?.target !== PI_PROVIDER_AUTH_TARGET
  ) {
    throw new PiSdkAuthDeliveryError();
  }
  const values = deliveries[0].values;
  if (
    Object.keys(values).join(',') !== 'apiKey' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === ''
  ) {
    throw new PiSdkAuthDeliveryError();
  }
  return values['apiKey'];
}

/**
 * Require the exact resolved provider identity used by Pi's model registry.
 * @param context - Refs-only runtime provider context
 * @returns Resolved provider context
 */
export function requirePiProviderContext(context: ProviderContext | undefined): ResolvedProviderContext {
  if (context?.state !== 'resolved') throw new PiSdkProviderContextError();
  return context;
}

/**
 * Require the exact protocol declared on the selected adapter/provider ref.
 * @param protocol - Selected adapter/provider protocol
 * @returns Declared protocol
 */
export function requirePiProviderProtocol(protocol: ProtocolId | undefined): ProtocolId {
  if (protocol === undefined) throw new PiSdkProviderProtocolError();
  return protocol;
}
