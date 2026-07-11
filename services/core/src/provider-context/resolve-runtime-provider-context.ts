import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderContext, ResolvedProviderContext } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../adapter-subsystem/namespace.js';
import type { AdapterRuntimeSnapshotErrorCode } from '../adapter-subsystem/schemas.js';

/** Stable failures for adapter-qualified provider-context resolution. */
export type RuntimeProviderContextResolutionErrorCode = AdapterRuntimeSnapshotErrorCode | 'provider-context-unresolved';

/** Typed, credential-free failure raised before an execution consumer starts. */
export class RuntimeProviderContextResolutionError extends Error {
  /**
   * Create an adapter-qualified provider-context failure.
   * @param code - Stable resolution failure category.
   * @param adapterName - Adapter selected for the execution.
   * @param providerConfigId - Provider config selected for the execution.
   */
  public constructor(
    public readonly code: RuntimeProviderContextResolutionErrorCode,
    public readonly adapterName: string,
    public readonly providerConfigId: string,
  ) {
    super(`Provider context resolution failed (${code}) for adapter "${adapterName}".`);
    this.name = 'RuntimeProviderContextResolutionError';
  }
}

/**
 * Resolve one provider context through the adapter-qualified atomic snapshot.
 *
 * Execution consumers must use this seam instead of the generic safe config
 * read or the provider-only snapshot: it verifies that the selected adapter,
 * provider definition, client, and authentication binding are compatible.
 * @param bus - Bus serving the adapter subsystem.
 * @param input - Exact adapter and provider-config selection.
 * @returns Resolved refs-only provider context from the atomic snapshot.
 */
export async function resolveRuntimeProviderContext(
  bus: IMakaioBus,
  input: { readonly adapterName: string; readonly providerConfigId: string },
): Promise<ResolvedProviderContext> {
  const resolution = await bus.request(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, input);
  if (resolution.status === 'error') {
    throw new RuntimeProviderContextResolutionError(resolution.code, input.adapterName, input.providerConfigId);
  }

  const runtime = resolution.runtime;
  if (
    runtime.adapterName !== input.adapterName ||
    runtime.snapshot.context.providerConfigId !== input.providerConfigId
  ) {
    throw new RuntimeProviderContextResolutionError(
      'snapshot-identity-mismatch',
      input.adapterName,
      input.providerConfigId,
    );
  }
  const providerContext: ProviderContext = runtime.snapshot.context;
  if (providerContext.state !== 'resolved') {
    throw new RuntimeProviderContextResolutionError(
      'provider-context-unresolved',
      input.adapterName,
      input.providerConfigId,
    );
  }
  return providerContext;
}
