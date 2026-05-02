import type { Account } from '../bus/schemas.js';
import type { StoredAccount } from '../interfaces/account-store.js';

/**
 * Strips the credential from a {@link StoredAccount} to produce a
 * public {@link Account} safe for bus transport.
 * @param stored - Internal account with credential
 * @returns Public account without credential
 */
export function toPublicAccount(stored: StoredAccount): Account {
  return {
    id: stored.id,
    label: stored.label,
    linkedClientAccountId: stored.linkedClientAccountId,
    metadata: stored.metadata,
    active: stored.active,
    detectedAt: stored.detectedAt,
    lastSeenAt: stored.lastSeenAt,
  };
}
