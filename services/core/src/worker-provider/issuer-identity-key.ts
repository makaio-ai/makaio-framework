import type { LockedWorkerRedemption } from './start-order.js';

/**
 * Read the opaque issuer key from the locked owner and check it against an existing winner.
 * @param redemption - The authoritative booking snapshot under the owner lock.
 * @returns The matching, nonempty issuer key, or undefined when the exchange must refuse.
 */
export function readIssuerIdentityKey(redemption: LockedWorkerRedemption): string | undefined {
  const { identityRevocationKey, stored } = redemption;
  if (typeof identityRevocationKey !== 'string' || identityRevocationKey.length === 0) return undefined;
  if (stored !== undefined && identityRevocationKey !== stored.accepted.revocationKey) return undefined;
  return identityRevocationKey;
}
