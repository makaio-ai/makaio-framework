import type { MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../../capability/index.js';
import { WORKER_CAPABILITY_ID, type IWorkerProvider } from './types.js';

export { WORKER_CAPABILITY_ID } from './types.js';

/**
 * Register a Worker provider with the capability registry.
 * @param bus - Makaio bus instance.
 * @param provider - Provider instance to register.
 * @returns Promise that resolves after registration handlers have completed.
 */
export function registerWorkerProvider(bus: MakaioBusLike, provider: IWorkerProvider): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: WORKER_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister a Worker provider from the capability registry.
 * @param bus - Makaio bus instance.
 * @param providerId - Provider identifier to remove.
 * @returns Promise that resolves after unregistration handlers have completed.
 */
export function unregisterWorkerProvider(bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: WORKER_CAPABILITY_ID,
    providerId,
  });
}
