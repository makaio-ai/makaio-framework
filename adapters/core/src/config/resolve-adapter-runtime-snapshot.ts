import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import type { AdapterRuntimeSnapshot, AdapterRuntimeSnapshotErrorCode } from '@makaio/services-core/adapter-subsystem';
import { bindProviderAuth, type BoundProviderAuthContext } from './resolve-adapter-auth.js';

export type { AdapterRuntimeSnapshotErrorCode } from '@makaio/services-core/adapter-subsystem';

/** Atomic adapter runtime snapshot with its exact refs-only auth binding. */
export interface BoundAdapterRuntimeSnapshot extends AdapterRuntimeSnapshot {
  /** Exact selected adapter delivery compiled without resolving plaintext. */
  readonly boundProviderAuth: BoundProviderAuthContext;
}

/** Typed credential-free atomic adapter runtime resolution failure. */
export class AdapterRuntimeSnapshotError extends Error {
  /**
   * Create an atomic runtime resolution failure.
   * @param code - Stable failure category returned by the subsystem
   */
  public constructor(public readonly code: AdapterRuntimeSnapshotErrorCode) {
    super(`Adapter runtime snapshot resolution failed (${code}).`);
    this.name = 'AdapterRuntimeSnapshotError';
  }
}

/**
 * Resolve and bind one adapter/provider runtime snapshot in a single subsystem read.
 *
 * The response carries refs and runtime-only delivery declarations but never
 * plaintext. Binding remains in Adapter Core so the lower subsystem does not
 * depend on this host-layer package.
 * @param bus - Runtime bus serving the adapter subsystem
 * @param input - Exact adapter name and provider config selection
 * @returns Atomic runtime metadata plus immutable refs-only auth binding
 */
export async function resolveAdapterRuntimeSnapshot(
  bus: IMakaioBus,
  input: { readonly adapterName: string; readonly providerConfigId: string },
): Promise<BoundAdapterRuntimeSnapshot> {
  const resolution = await bus.request(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, input);
  if (resolution.status === 'error') {
    throw new AdapterRuntimeSnapshotError(resolution.code);
  }

  const runtime = resolution.runtime;
  if (
    runtime.adapterName !== input.adapterName ||
    runtime.snapshot.context.providerConfigId !== input.providerConfigId
  ) {
    throw new AdapterRuntimeSnapshotError('snapshot-identity-mismatch');
  }
  const boundProviderAuth = bindProviderAuth({
    auth: runtime.snapshot.context.auth,
    adapterProviderAuth: runtime.adapterProviderAuth,
    compatibleProviderAuths: runtime.compatibleProviderAuths,
  });
  if (
    boundProviderAuth.auth.method.owner === 'client' &&
    boundProviderAuth.auth.method.clientId !== runtime.adapterClientId
  ) {
    throw new AdapterRuntimeSnapshotError('client-incompatible');
  }
  return { ...runtime, boundProviderAuth };
}
