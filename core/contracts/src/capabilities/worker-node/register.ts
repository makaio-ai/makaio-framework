import type { MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../../capability/index.js';
import { WORKER_NODE_CAPABILITY_ID, type IWorkerNodeProvider } from './types.js';

export { WORKER_NODE_CAPABILITY_ID } from './types.js';

/**
 * Register a WorkerNode provider with the capability registry.
 * @param bus - Makaio bus instance.
 * @param provider - Provider instance to register.
 * @returns Promise that resolves after registration handlers have completed.
 */
export function registerWorkerNodeProvider(bus: MakaioBusLike, provider: IWorkerNodeProvider): Promise<void> {
  return bus.emit(CapabilitySubjects.register, {
    capabilityId: WORKER_NODE_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister a WorkerNode provider from the capability registry.
 * @param bus - Makaio bus instance.
 * @param providerId - Provider identifier to remove.
 * @returns Promise that resolves after unregistration handlers have completed.
 */
export function unregisterWorkerNodeProvider(bus: MakaioBusLike, providerId: string): Promise<void> {
  return bus.emit(CapabilitySubjects.unregister, {
    capabilityId: WORKER_NODE_CAPABILITY_ID,
    providerId,
  });
}
