import type { IMakaioBus } from '@makaio/bus-core';
import { CapabilitySubjects } from '../../capability/index.js';
import type { IAutoLaunchProvider } from './types.js';

/** Capability identifier for auto-launch providers. */
export const AUTO_LAUNCH_CAPABILITY_ID = 'autoLaunch';

/**
 * Register an auto-launch provider with the capability bus.
 * @param bus - The Makaio bus instance.
 * @param provider - The auto-launch provider instance to register.
 */
export function registerAutoLaunchProvider(bus: IMakaioBus, provider: IAutoLaunchProvider): void {
  bus.emit(CapabilitySubjects.register, {
    capabilityId: AUTO_LAUNCH_CAPABILITY_ID,
    provider,
  });
}
