import type { IMakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects } from '../../capability/index.js';
import { SERVER_CAPABILITY_ID, type IServerProvider } from './types.js';

export { SERVER_CAPABILITY_ID } from './types.js';

/**
 * Register an HTTP server provider with the capability bus.
 * @param bus - The Makaio bus instance.
 * @param provider - The server provider instance to register.
 * @returns Promise that resolves after registration handlers have completed.
 */
export function registerServerProvider(bus: IMakaioBus, provider: IServerProvider): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: SERVER_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister an HTTP server provider from the capability bus.
 * @param bus - The Makaio bus instance.
 * @param providerId - The provider ID to unregister.
 * @returns Promise that resolves after unregistration handlers have completed.
 */
export function unregisterServerProvider(bus: IMakaioBus, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: SERVER_CAPABILITY_ID,
    providerId,
  });
}
