import type { CallContext, MakaioBusLike } from '@makaio/core';
import { CapabilitySubjects } from '../../capability/index.js';
import type { IGitHookEventsProvider } from './types.js';

/**
 * Capability identifier for git hook event providers.
 */
export const GIT_HOOK_EVENTS_CAPABILITY_ID = 'git-hook-events';

/**
 * Register a git hook events provider with the capability bus.
 * @param call - The call context the registration is sent with.
 * @param bus - The Makaio bus instance.
 * @param provider - The git hook events provider instance to register.
 * @returns Promise that resolves after registration handlers have completed.
 */
export function registerGitHookEventsProvider(
  call: CallContext,
  bus: MakaioBusLike,
  provider: IGitHookEventsProvider,
): Promise<void> {
  return bus.emit(call, CapabilitySubjects.register, {
    capabilityId: GIT_HOOK_EVENTS_CAPABILITY_ID,
    provider,
  });
}

/**
 * Unregister a git hook events provider from the capability bus.
 * @param call - The call context the unregistration is sent with.
 * @param bus - The Makaio bus instance.
 * @param providerId - The provider ID to remove from the capability bucket.
 * @returns Promise that resolves after unregistration handlers have completed.
 */
export function unregisterGitHookEventsProvider(
  call: CallContext,
  bus: MakaioBusLike,
  providerId: string,
): Promise<void> {
  return bus.emit(call, CapabilitySubjects.unregister, {
    capabilityId: GIT_HOOK_EVENTS_CAPABILITY_ID,
    providerId,
  });
}
