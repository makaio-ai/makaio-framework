import type { IdentityProvider, MachineIdentity } from './identity.js';

/**
 * Ephemeral identity provider — generates a new random UUID on each load.
 * Used by framework users and containers that don't persist machine identity.
 */
export class EphemeralIdentityProvider implements IdentityProvider {
  /**
   * Generate a fresh random UUID as the machine identity.
   * @returns A new ephemeral machine identity
   */
  public async load(): Promise<MachineIdentity> {
    return { machineId: globalThis.crypto.randomUUID() };
  }
}
