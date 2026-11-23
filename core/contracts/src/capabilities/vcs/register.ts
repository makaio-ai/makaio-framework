import type { CallContext, MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../../capability/index.js';
import type { IVCSProvider } from './types.js';

/**
 * Capability identifier for version-control providers.
 */
export const VCS_CAPABILITY_ID = 'vcs';

/**
 * Register a VCS provider with the capability bus.
 * @param call - The call context the registration is sent with
 * @param bus - The Makaio bus instance
 * @param provider - The VCS provider instance to register
 * @returns Promise that resolves after registration handlers have completed
 */
export function registerVCSProvider(call: CallContext, bus: MakaioBusLike, provider: IVCSProvider): Promise<void> {
  return bus.emit(call, CapabilitySubjects.register, {
    capabilityId: VCS_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister a VCS provider from the capability bus.
 * @param call - The call context the registration is sent with
 * @param bus - The Makaio bus instance
 * @param providerId - VCS provider ID to unregister
 * @returns Promise that resolves after unregistration handlers have completed
 */
export function unregisterVCSProvider(call: CallContext, bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(call, CapabilitySubjects.unregister, {
    capabilityId: VCS_CAPABILITY_ID,
    providerId,
  });
}
