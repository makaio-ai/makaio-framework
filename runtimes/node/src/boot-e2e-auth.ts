import { E2EAuth } from '@makaio/bus-transport-websocket';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';

/**
 * Build an {@link E2EAuth} strategy from a persisted machine identity.
 *
 * Called after services start so the signing keypair is available. The
 * resulting strategy is hot-swapped into the pre-constructed dispatching auth.
 * @param identity - Persisted machine identity with signing key pair.
 * @param resolver - Callback resolving a peer's signing public key. Returning
 *   `null` causes E2E auth to reject the peer.
 * @returns Configured E2E auth strategy.
 */
export function createBootE2EAuth(
  identity: PersistedMachineIdentity,
  resolver: (peerId: string) => Promise<CryptoKey | null>,
): E2EAuth {
  return new E2EAuth({
    signingKeyPair: identity.signingKeyPair,
    identityId: identity.machineId,
    getPeerSigningKey: resolver,
  });
}
