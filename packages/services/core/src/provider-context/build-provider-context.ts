import type { IMakaioBus } from '@makaio/bus-core';
import { type ProviderContext } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../adapter-subsystem/namespace.js';

/**
 * Resolve the bus-safe provider context via the adapter subsystem subject.
 *
 * The adapter subsystem owns the canonical provider-context assembly. This
 * helper keeps framework consumers on that seam while preserving the local
 * error contract for missing provider configs.
 * @param bus - Bus instance used to request the subsystem subject
 * @param providerConfigId - Provider config identifier to resolve
 * @returns Unresolved provider context with credential refs
 * @throws Error when the config cannot be found
 */
export async function buildProviderContext(bus: IMakaioBus, providerConfigId: string): Promise<ProviderContext> {
  const { context } = await bus.request(AdapterSubsystemSubjects.buildProviderContext, { providerConfigId });
  if (!context) {
    throw new Error(`[buildProviderContext] ProviderConfig '${providerConfigId}' not found`);
  }
  return context;
}
