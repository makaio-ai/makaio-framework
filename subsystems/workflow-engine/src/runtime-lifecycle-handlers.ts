import type { IMakaioBus } from '@makaio/bus-core';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';
import { registerOperationAdmissionHandler } from './operation-admission.js';
import { registerRuntimeRegistrationHandler } from './runtime-registration.js';

/**
 * Register the runtime's readiness and operation-admission gates under one Authority.
 * @param bus - Bus receiving the authenticated runtime protocol.
 * @param authority - Authority shared by registration and operation admission.
 * @param addCleanup - Attach each cleanup immediately to the executor's post-drain lifecycle.
 */
export function registerRuntimeLifecycleHandlers<TOutcome>(
  bus: IMakaioBus,
  authority: ExecutionAttemptAuthority<TOutcome>,
  addCleanup: (cleanup: () => void) => void,
): void {
  addCleanup(registerRuntimeRegistrationHandler(bus, { bus, authority }));
  addCleanup(registerOperationAdmissionHandler(bus, { bus, authority }));
}
