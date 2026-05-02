import path from 'node:path';
import type { IdentityProvider, MachineIdentity } from '@makaio/kernel';
import { loadOrCreateMachineIdentity } from '@makaio/machine-identity';

/**
 * Node.js identity provider that persists ECDH/ECDSA keypairs under `{makaioHome}/keys/`.
 *
 * Returns only the stable `machineId` string via the {@link IdentityProvider}
 * interface. The composition root is responsible for separately registering
 * the full `PersistedMachineIdentity` (with crypto keys) on the bus
 * via `RuntimeSubjects.machineIdentity` when LAN/E2E auth is needed.
 */
export class PersistedIdentityProvider implements IdentityProvider {
  private readonly keysDir: string;

  /**
   * Create a new PersistedIdentityProvider.
   * @param makaioHome - Resolved `.makaio` home directory (e.g. `~/.makaio`).
   *   Keys are stored under `{makaioHome}/keys`.
   */
  public constructor(makaioHome: string) {
    this.keysDir = path.join(makaioHome, 'keys');
  }

  /**
   * Load or create the persisted machine identity.
   * @returns Machine identity containing the stable machine ID.
   */
  public async load(): Promise<MachineIdentity> {
    const identity = await loadOrCreateMachineIdentity(this.keysDir);
    return { machineId: identity.machineId };
  }
}
